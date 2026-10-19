/**
 * #226 — a resumed run re-reads its decision manifest.
 *
 * The manifest used to be resolved at first launch only (`service-runs.ts`
 * `startRun`, inside `if (!options.resumeRunId)`), so a `## Decisions` row the
 * plan amended after launch — a `permission.destructive` widened for a release
 * phase — never reached the live run, and every push the plan already allowed
 * raised a person's card instead. A resume now takes the plan's written rows
 * as they stand (`rereadManifest`), and `Runner.start` journals
 * `run.decisions-reread` with what moved.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { rereadManifest } = await import('../server/prelude.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
import type { ResolvedManifest } from '../server/runner/state.ts';
import type { SpawnFn, SpawnOutcome } from '../server/runner/spawn.ts';

const LAUNCHED: ResolvedManifest = {
  decisions: [
    { key: 'permission.destructive', value: 'deny; allow `git push` of the run branch', owner: 'op', state: 'answered', source: 'plan', blocking: 'yes', origin: 'plan' },
    { key: 'stop', value: 'keep-going', owner: 'op', state: 'answered', source: 'plan', blocking: 'no', origin: 'plan' },
    { key: 'relay', value: 'off', state: 'answered', source: 'default', blocking: 'no', origin: 'default' },
    { key: 'ambiguity', value: 'ruling', state: 'answered', source: 'default', blocking: 'no', origin: 'default' },
  ],
  accounts: [], credentials: { named: [], held: [], missing: [] } as never, delivery: null as never,
  probes: { accounts: { status: 'ok', reason: 'fine' } }, at: '2026-10-01T00:00:00Z',
} as ResolvedManifest;

const row = (key: string, value: string, extra: Record<string, string | null> = {}) => ({
  key, value, owner: 'op', state: 'answered', blocking: 'no', source: 'plan', evidence: '', phase: null, ...extra,
}) as never;

test('rereadManifest: a widened row replaces the run\'s, a new one arrives, an unwritten one and a default stand', () => {
  const { manifest, changes } = rereadManifest(LAUNCHED, [
    row('permission.destructive', 'deny; allow `git push` of the run branch and `main` by phase 22', { blocking: 'yes' }),
    row('relay', 'last-resort'),
    row('budgets', 'per phase ≤ $150'),
  ]);
  const by = Object.fromEntries(manifest.decisions.map((d) => [d.key, d]));
  assert.match(by['permission.destructive']!.value, /`main` by phase 22/, 'the amendment is live');
  assert.equal(by.stop!.value, 'keep-going', 'a row the plan no longer writes keeps the launch\'s answer: only the prelude can say what it falls back to');
  assert.equal(by.relay!.value, 'last-resort');
  assert.equal(by.relay!.origin, 'plan');
  assert.equal(by.budgets!.value, 'per phase ≤ $150');
  assert.equal(by.ambiguity!.source, 'default', 'a synthesised row stands as the launch resolved it');
  assert.deepEqual(manifest.probes, LAUNCHED.probes, 'a resume is answered at its own door: the probes are the launch\'s');
  assert.deepEqual(changes.map((c) => [c.key, c.change]), [
    ['permission.destructive', 'changed'], ['relay', 'added'], ['budgets', 'added'],
  ]);
  assert.equal(changes[0]!.from, 'deny; allow `git push` of the run branch');
});

test('rereadManifest: a row the plan now leaves outstanding is held, never applied', () => {
  const { manifest, changes, held } = rereadManifest(LAUNCHED, [
    row('permission.destructive', 'to be decided', { state: 'outstanding', blocking: 'yes' }),
    row('budgets', '', { state: '' }),
  ]);
  assert.deepEqual(changes, []);
  assert.deepEqual(held.map((c) => [c.key, c.change]), [['permission.destructive', 'changed'], ['budgets', 'added']]);
  assert.equal(manifest.decisions.find((d) => d.key === 'permission.destructive')?.value, LAUNCHED.decisions[0]!.value, 'the launch\'s answer stands');
  assert.equal(manifest.decisions.find((d) => d.key === 'budgets'), undefined);
});

test('rereadManifest: an unchanged plan moves nothing and says so', () => {
  const { manifest, changes } = rereadManifest(LAUNCHED, [
    row('permission.destructive', 'deny; allow `git push` of the run branch', { blocking: 'yes' }),
    row('stop', 'keep-going'),
  ]);
  assert.deepEqual(changes, []);
  assert.deepEqual(manifest.decisions.map((d) => d.key), LAUNCHED.decisions.map((d) => d.key));
});

/* ------------------------------------------------------------------ *
 * the runner takes it and journals it
 * ------------------------------------------------------------------ */

function repo(): { root: string; scripts: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-reread-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  for (const dir of [scripts, state, join(root, 'docs', 'plans')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n', 'utf8');
  writeFileSync(join(state, 'done'), '', 'utf8');
  const write = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then
      echo "done: 1"; echo "in-progress: "; echo "stuck: "; echo "ready: "; echo "waiting: "
    else
      echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: "
    fi ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo S ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && { echo "phase ${3:-?}: free"; exit 0; }\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, state };
}

function session(r: { state: string }): SpawnFn {
  return async (): Promise<SpawnOutcome> => {
    writeFileSync(join(r.state, 'done'), '1\n', 'utf8');
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: 'sess-reread', costUsd: 0.01, turns: 2, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    };
  };
}

const PERSON = { by: 'mobin', via: 'browser', origin: 'test', remoteUser: null };
const CLOCK = { by: 'console', via: 'timer', origin: 'converge', remoteUser: null, door: 'converge-relaunch' };

async function resumed(actor: Record<string, unknown>) {
  const r = repo();
  const first = new Runner({ scriptsDir: r.scripts, spawn: session(r), verificationText: () => '`true`' });
  await first.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', manifest: LAUNCHED });
  await first.wait();
  const id = first.current()!.id;

  const reread = rereadManifest(LAUNCHED, [row('permission.destructive', 'allow `main` by phase 22', { blocking: 'yes' })]);
  const second = new Runner({ scriptsDir: r.scripts, spawn: session(r), verificationText: () => '`true`' });
  await second.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', resumeRunId: id, manifestReread: reread, actor } as never);
  await second.wait();
  const lines = readFileSync(journalFile(r.root, 'demo', id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { state: second.current()!, reread: lines.filter((l) => l.event === 'run.decisions-reread') };
}

test('a person\'s resume takes the re-read manifest and journals run.decisions-reread with what moved', async () => {
  const { state, reread } = await resumed(PERSON);
  assert.equal(state.manifest?.decisions.find((d) => d.key === 'permission.destructive')?.value, 'allow `main` by phase 22');
  assert.equal(reread.length, 1, 'said once, by the resume');
  assert.equal(reread[0].data.applied, true);
  assert.deepEqual(reread[0].data.changes.map((c: { key: string; change: string }) => [c.key, c.change]),
    [['permission.destructive', 'changed']]);
});

test('a resume no person pressed applies nothing — the rows are in the tree a session can write — and says what it held', async () => {
  const { state, reread } = await resumed(CLOCK);
  assert.equal(state.manifest?.decisions.find((d) => d.key === 'permission.destructive')?.value, LAUNCHED.decisions[0]!.value);
  assert.equal(reread.length, 1);
  assert.equal(reread[0].data.applied, false);
  assert.equal(reread[0].data.changes.length, 1, 'the journal still names the amendment, for the next press');
});

test('the start door re-reads the plan\'s decisions on every resume — never only at first launch', async () => {
  const r = repo();
  const first = new Runner({ scriptsDir: r.scripts, spawn: session(r), verificationText: () => '`true`' });
  await first.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', manifest: LAUNCHED });
  await first.wait();
  const id = first.current()!.id;

  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowRun: true, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const started: Record<string, unknown>[] = [];
  Object.assign(service as object, {
    root: { ok: true, path: r.root },
    store: {
      get: () => ({
        slug: 'demo',
        plan: {
          phased: true, graph: [{ phase: 1, repos: '' }], phases: {}, sessionBudget: { accounts: [] },
          decisions: [row('permission.destructive', 'deny', { blocking: 'yes' }), row('stop', 'keep-going')],
        },
        // The twin's row wins for its key, as `--decisions` merges it.
        decisionsTwin: [row('permission.destructive', 'deny; allow `main` by phase 22', { blocking: 'yes', source: 'run' })],
      }),
      list: () => [],
    },
    liveRunner: () => null,
    foreignRunHoldingWork: () => null,
    assertNotClaimed: () => {},
    admitStart: () => ({ ok: true }),
    runnerFor: () => ({
      start: async (options: Record<string, unknown>) => { started.push(options); return { id, slug: 'demo' }; },
    }),
  });
  await (service as unknown as { startRun: (slug: string, o: Record<string, unknown>) => Promise<unknown> })
    .startRun('demo', { resumeRunId: id });
  const carried = started[0]!.manifestReread as { manifest: ResolvedManifest; changes: { key: string; change: string }[] };
  assert.ok(carried, 'a resume carries the re-read manifest to the runner');
  assert.equal(carried.manifest.decisions.find((d) => d.key === 'permission.destructive')?.value, 'deny; allow `main` by phase 22');
  assert.deepEqual(carried.changes.map((c) => [c.key, c.change]), [['permission.destructive', 'changed']]);
});
