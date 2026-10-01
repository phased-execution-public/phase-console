/**
 * A resumed run keeps its settings (control-tower phase 77, #101 #102).
 *
 * Seen on hub 4123 on 2026-09-24 and twice on 2026-09-25: an operator (or an
 * agent) brought a stopped run back with `POST start {resumeRunId}` and got a
 * run that was not the one they stopped. The route filled what the body left
 * out with the CONSOLE's defaults — `autonomy: keep-going`, both budgets
 * `null` — so a `halt-on-everything` run with a $40 phase budget came back
 * keep-going with no ceiling; and the runner's resume branch never read
 * `permissionProfile`, `relay`, `resumeOnRestart` or `accounts` at all, so
 * `start {resumeRunId, resumeOnRestart: true}` answered a run still reading
 * `false`, and the next console restart stranded it again. Nor could the
 * settings verb change those three: they were start-only.
 *
 * #21's ruling stands under all of it: the stored run is the source of truth.
 *
 * RS-1  the start door hands a resume SILENCE for every field the body omits
 * RS-2  the runner's resume keeps each stored setting a start does not name
 * RS-3  a setting the start does name overrides the stored one — journalled
 * RS-4  `resumeOnRestart`, `relay` and `accounts` are settings-verb fields,
 *       stored and journalled on a stored run and on a live one
 * (RS-5 — the wire lists and the client's live sheet — is in
 * `run-settings-parity.test.ts` and `run-settings.test.ts`; RS-6 — `resume`
 * lifts a settled pause — in `press-does-what-it-says.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUN_START_FIELDS } from '../shared/run-settings.js';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { loadRun, newRun, saveRun } = await import('../server/runner/state.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { pressActor } = await import('../server/actor.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PERSON = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;

/** Every setting a stopped run carries that a resume must not quietly change. */
const STORED = {
  autonomy: 'halt-on-everything',
  permissionProfile: 'bypass',
  relay: 'last-resort',
  resumeOnRestart: false,
  accounts: [{ id: 'default', minHeadroomPct: 20 }, { id: 'acct-b', minHeadroomPct: 10 }],
  phaseBudgetUsd: 40,
  runBudgetUsd: 300,
  mcpPolicy: 'require',
  messaging: 'off',
} as const;

/* ------------------------------------------------------------------ *
 * A service over a real plan — the route's door
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-25
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S
- **Verification:** \`true\`

### Phase 2 — cart api
- **Size:** S
- **Verification:** \`true\`
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-resume-keeps-svc-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** A stored run, paused on phase 2, carrying every setting in `STORED`. */
function pausedRun(root: string, slug = 'alpha'): RunState {
  const state = newRun({
    slug, root,
    autonomy: STORED.autonomy,
    permissionProfile: STORED.permissionProfile,
    relay: STORED.relay,
    resumeOnRestart: STORED.resumeOnRestart,
    accounts: STORED.accounts.map((row) => ({ ...row })),
    phaseBudgetUsd: STORED.phaseBudgetUsd,
    runBudgetUsd: STORED.runBudgetUsd,
    mcpPolicy: STORED.mcpPolicy,
    messaging: STORED.messaging,
  });
  state.status = 'paused';
  saveRun(state);
  return state;
}

type Captured = { status: number; body: Record<string, unknown> };

/** One HTTP call against the real route table, read the way a client reads it. */
async function call(svc: unknown, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4123', 'user-agent': 'Mozilla/5.0 (resume test)' },
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

/** Replace `startRun` with a recorder that answers the stored run. */
function recordStarts(svc: ReturnType<typeof service>, root: string): Record<string, unknown>[] {
  const starts: Record<string, unknown>[] = [];
  (svc as unknown as { startRun: (slug: string, options: Record<string, unknown>) => Promise<RunState> }).startRun =
    async (_slug, options) => {
      starts.push(options);
      return (options.resumeRunId ? loadRun(root, 'alpha', String(options.resumeRunId), null) : newRun({ slug: 'alpha', root }))!;
    };
  return starts;
}

const journalOn = (root: string, slug: string, runId: string) => readFileSync(journalFile(root, slug, runId), 'utf8')
  .split('\n').filter(Boolean)
  .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });

/* ------------------------------------------------------------------ *
 * A runner over stub scripts: a board with nothing left to board
 * ------------------------------------------------------------------ */

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function stubRepo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-resume-keeps-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  // Every phase done: a resumed loop reads the board, finds nothing to board,
  // and finishes — so what a test reads is exactly what the resume did.
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
case "\${2:-}" in
  --memory-block) echo "done: 1,2"; echo "in-progress: "; echo "stuck: "; echo "ready: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase \${3:-} of $1" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function stubRunner(scripts: string) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: scripts,
    spawn: async () => { throw new Error('nothing should board: every phase is done'); },
    verificationText: () => '`true`',
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    onEvent: (event, data) => events.push({ event, data }),
  } as never);
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** The settings `STORED` names, read off a run. */
const settingsOf = (run: RunState) => ({
  autonomy: run.autonomy,
  permissionProfile: run.permissionProfile,
  relay: run.relay,
  resumeOnRestart: run.resumeOnRestart,
  accounts: run.accounts,
  phaseBudgetUsd: run.phaseBudgetUsd,
  runBudgetUsd: run.runBudgetUsd,
  mcpPolicy: run.mcpPolicy,
  messaging: run.messaging,
});

/* ------------------------------------------------------------------ *
 * RS-1 — the door hands a resume silence, not the console's defaults
 * ------------------------------------------------------------------ */

test('RS-1: `start {resumeRunId}` naming nothing reaches startRun with every setting unsaid — never a console default (#102)', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = pausedRun(root);
    const out = await call(svc, '/api/run/alpha/start', { resumeRunId: run.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(starts.length, 1);
    const options = starts[0];
    assert.equal(options.resumeRunId, run.id);
    // Every field the start door reads is a setting the stored run already
    // answered. Absent on the wire must be absent here: `undefined` is how the
    // runner's resume branch reads "keep what the run is".
    const said = RUN_START_FIELDS
      .filter((field) => field !== 'resumeRunId')
      .filter((field) => options[field] !== undefined)
      .map((field) => `${field}=${JSON.stringify(options[field])}`);
    assert.deepEqual(said, [], `the door filled a resume's silence with its own words: ${said.join(', ')}`);
  } finally {
    svc.close();
  }
});

test('RS-1: a resume that NAMES a setting passes it; a fresh start keeps the door\'s own defaults', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const starts = recordStarts(svc, root);
    const run = pausedRun(root);
    await call(svc, '/api/run/alpha/start', {
      resumeRunId: run.id, autonomy: 'keep-going', permissionProfile: 'trusted', phaseBudgetUsd: null,
    });
    assert.equal(starts[0].autonomy, 'keep-going');
    assert.equal(starts[0].permissionProfile, 'trusted');
    assert.equal(starts[0].phaseBudgetUsd, null, '`null` is a choice — "no ceiling" — and travels as one');
    // A typo is never the reason a run takes the guard rails off — or keeps
    // them off when the person asked for something: it is `guarded`.
    await call(svc, '/api/run/alpha/start', { resumeRunId: run.id, permissionProfile: 'bypas' });
    assert.equal(starts[1].permissionProfile, 'guarded');

    // A FRESH start is unchanged: the door's defaults still speak for it.
    await call(svc, '/api/run/alpha/start', {
      resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 0 }],
    });
    const fresh = starts[2];
    assert.equal(fresh.resumeRunId, undefined);
    assert.equal(fresh.permissionProfile, 'guarded', 'a fresh start that names no profile is guarded');
  } finally {
    svc.close();
  }
});

/* ------------------------------------------------------------------ *
 * RS-2 / RS-3 — the runner's resume: inherit, or apply and journal
 * ------------------------------------------------------------------ */

test('RS-2: a resume that names nothing keeps every stored setting — autonomy, profile, relay, resumeOnRestart, accounts, budgets (#101 #102)', async () => {
  const r = stubRepo();
  try {
    const stored = pausedRun(r.root, 'demo');
    const { instance, events } = stubRunner(r.scripts);
    const state = await instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id, actor: pressActor(PERSON as never) });
    await instance.wait();
    const disk = JSON.parse(readFileSync(runFile(r.root, 'demo', state.id), 'utf8')) as RunState;
    assert.deepEqual(settingsOf(disk), settingsOf(stored));
    assert.equal(journalled(events, 'run.resume-settings').length, 0, 'nothing was overridden, so nothing is journalled as one');
  } finally {
    r.cleanup();
  }
});

test('RS-3: a resume that names a setting applies it over the stored run, and journals each override from → to (#101)', async () => {
  const r = stubRepo();
  try {
    const stored = pausedRun(r.root, 'demo');
    const { instance, events } = stubRunner(r.scripts);
    const accounts = [{ id: 'default', minHeadroomPct: 10 }];
    const state = await instance.start({
      slug: 'demo', root: r.root, resumeRunId: stored.id, actor: pressActor(PERSON as never),
      resumeOnRestart: true, relay: 'off', accounts, permissionProfile: 'trusted', autonomy: 'keep-going',
    });
    await instance.wait();
    const disk = JSON.parse(readFileSync(runFile(r.root, 'demo', state.id), 'utf8')) as RunState;
    assert.equal(disk.resumeOnRestart, true, 'the answer that stops the next restart stranding this run');
    assert.equal(disk.relay, 'off');
    assert.deepEqual(disk.accounts, accounts, 'the relaunch\'s pool replaces the stored one');
    assert.equal(disk.permissionProfile, 'trusted');
    assert.equal(disk.autonomy, 'keep-going');
    // What the start did NOT name is still the run's own.
    assert.equal(disk.phaseBudgetUsd, STORED.phaseBudgetUsd);
    assert.equal(disk.mcpPolicy, STORED.mcpPolicy);

    const lines = journalled(events, 'run.resume-settings');
    assert.equal(lines.length, 1, 'one line names every override the resume applied');
    const overridden = lines[0].overridden as Record<string, { from: unknown; to: unknown }>;
    assert.deepEqual(overridden.resumeOnRestart, { from: false, to: true });
    assert.deepEqual(overridden.relay, { from: 'last-resort', to: 'off' });
    assert.deepEqual(overridden.permissionProfile, { from: 'bypass', to: 'trusted' });
    assert.deepEqual(overridden.autonomy, { from: 'halt-on-everything', to: 'keep-going' });
    assert.deepEqual(overridden.accounts, { from: STORED.accounts, to: accounts });
    assert.equal(overridden.phaseBudgetUsd, undefined, 'an inherited setting is not an override');
    assert.equal(lines[0].by, 'operator');
    // The profile is the one setting that changes what a session may DO: it
    // keeps its own line, as a mid-run change does.
    const profile = journalled(events, 'run.permission-profile');
    assert.deepEqual(profile.map((line) => [line.from, line.to]), [['bypass', 'trusted']]);
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * RS-4 — resumeOnRestart, relay and accounts are settings-verb fields
 * ------------------------------------------------------------------ */

test('RS-4: the settings verb stores resumeOnRestart, relay and accounts on a stored run, and journals the edit (#101)', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = pausedRun(root);
    const accounts = [{ id: 'default', minHeadroomPct: 5 }];
    const out = await call(svc, '/api/run/alpha/settings', { resumeOnRestart: true, relay: 'off', accounts });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const disk = JSON.parse(readFileSync(runFile(root, 'alpha', run.id), 'utf8')) as RunState;
    assert.equal(disk.resumeOnRestart, true);
    assert.equal(disk.relay, 'off');
    assert.deepEqual(disk.accounts, accounts);
    // Journalled like any other setting change — on the stored run's own
    // journal, with who asked (#22's rule for an edit no loop made).
    const line = journalOn(root, 'alpha', run.id).find((entry) => entry.event === 'run.reconfigured');
    assert.ok(line, 'a stored settings edit left no line in the run\'s history');
    assert.equal((line!.data?.patch as Record<string, unknown>)?.resumeOnRestart, true);
    assert.equal((line!.data?.patch as Record<string, unknown>)?.relay, 'off');
    assert.deepEqual((line!.data?.patch as Record<string, unknown>)?.accounts, accounts);
    assert.equal(line!.data?.stored, true);
    assert.equal(line!.data?.by, 'operator');

    // A pool naming no account this console knows is refused by name, not
    // stored as an empty list that would read as "every account".
    const refused = await call(svc, '/api/run/alpha/settings', { accounts: [{ id: 'nobody-here', minHeadroomPct: 5 }] });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /accounts/);
    // A relay word off the vocabulary is dropped, the way every closed word is.
    await call(svc, '/api/run/alpha/settings', { relay: 'sometimes' });
    assert.equal((JSON.parse(readFileSync(runFile(root, 'alpha', run.id), 'utf8')) as RunState).relay, 'off');
  } finally {
    svc.close();
  }
});

test('RS-4: a live run takes the same three through `configure`, journalled as `run.reconfigured`', async () => {
  const r = stubRepo();
  try {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { instance, events } = stubRunner(r.scripts);
    // Held in the auth probe, so the run is live while it is reconfigured.
    (instance as unknown as { deps: { checkAuth: () => Promise<unknown> } }).deps.checkAuth =
      async () => { await held; return { loggedIn: true, checkedAt: '' }; };
    const starting = instance.start({
      slug: 'demo', root: r.root, autonomy: 'keep-going', resumeOnRestart: false, relay: 'last-resort',
      accounts: [{ id: 'default', minHeadroomPct: 20 }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(instance.configure({ resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 5 }] }), true);
    release();
    const state = await starting;
    await instance.wait();
    const disk = JSON.parse(readFileSync(runFile(r.root, 'demo', state.id), 'utf8')) as RunState;
    assert.equal(disk.resumeOnRestart, true);
    assert.equal(disk.relay, 'off');
    assert.deepEqual(disk.accounts, [{ id: 'default', minHeadroomPct: 5 }]);
    const line = journalled(events, 'run.reconfigured').at(-1);
    assert.equal((line?.patch as Record<string, unknown> | undefined)?.resumeOnRestart, true);
    assert.equal((line?.patch as Record<string, unknown> | undefined)?.relay, 'off');
  } finally {
    r.cleanup();
  }
});
