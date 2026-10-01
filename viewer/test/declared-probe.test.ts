/**
 * The ingest probe refuses what the console would never run (control-tower phase 88, #125).
 *
 * The #125 ref was refused by the console's policy at its FIRST probe — three seconds after the
 * session that wrote it had parked and gone, so nothing could fix it and nothing would resume the
 * phase. The ingest probe (phase 50) already asked every declared ref while the session was still
 * inside `phase-outcome.sh`, but the script acted only on `landed`, and a `cmd:` ref was judged only
 * when `watchCmdRefs` was on.
 *
 * DP-1  a refused ref answers `verdict: refused` with a quote-free sentence naming it and why;
 *       a landed ref still wins — the wait is over either way
 * DP-2  `probeDeclared` refuses a `cmd:` ref by its shape (a shell variable, a relative path) and by
 *       the run policy WITHOUT running it, whatever `watchCmdRefs` says; a phase naming itself is
 *       refused; a sibling already done has landed
 * DP-3  the script hears the refusal and exits 2 with the console's reason — nothing written
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WatchState } from '../server/watch-refs.ts';
import type { RunState } from '../server/runner/state.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { runDir } = await import('../server/runner/state.ts');
const { answerDeclaredProbe } = await import('../server/declared-probe.ts');
const { WatchScheduler } = await import('../server/watch-scheduler.ts');
const { judgeCommand } = await import('../server/runner/verify.ts');
const { handleApi } = await import('../server/api/routes.ts');

const SCRIPT = join(SKILL_DIR, 'scripts', 'phase-outcome.sh');
const PUSH = 'cmd:"git push origin main"';

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function stage(root: string, watch: string[]): string {
  const dir = runDir(root, 'demo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'run-abc123-p4-outcome.json.tmp.4242');
  writeFileSync(path, JSON.stringify({ version: 1, slug: 'demo', phase: 4, status: 'waiting-external', watch, written_at: new Date().toISOString() }));
  return path;
}

function repoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-declared-probe-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  return root;
}

/** The real scheduler's ingest probe over one run: phase 43 done, `watchCmdRefs` OFF. */
function schedulerWith(): InstanceType<typeof WatchScheduler> {
  const run = { id: 'abc123', slug: 'demo', status: 'running', phases: { '43': { phase: 43, status: 'done' } } } as unknown as RunState;
  return new WatchScheduler({ runs: () => [{ slug: 'demo', state: run }], judgeCommand, cmdRefsEnabled: () => false });
}

test('DP-1: a refused ref answers `refused` with the console\'s reason, quote-free; a landed ref still wins', async () => {
  const root = repoRoot();
  const refusedProbe = async (_s: string, _p: number, refs: readonly string[]) => ({
    landed: null, refs: refs.map((ref) => ({ ref, state: 'refused', detail: 'a "mutating" verb — git push' }) as WatchState),
  });
  const answer = await answerDeclaredProbe({ slug: 'demo', phase: 4, file: stage(root, [PUSH]) }, { root, probe: refusedProbe });
  assert.equal(answer.status, 200);
  assert.equal('verdict' in answer && answer.verdict, 'refused');
  if (answer.status !== 200 || answer.verdict !== 'refused') return;
  assert.equal(answer.ref, PUSH);
  assert.match(answer.sentence, /^refused — cmd:'git push origin main': a 'mutating' verb — git push\./);
  assert.match(answer.sentence, /nothing would ever resume this phase/);
  assert.doesNotMatch(answer.sentence, /"/, 'quote-free, so the script lifts it from the JSON as it is');

  const mixed = async (_s: string, _p: number, refs: readonly string[]) => ({
    landed: { ref: refs[1], state: 'landed', detail: 'phase 43 is done' } as WatchState,
    refs: [{ ref: refs[0], state: 'refused', detail: 'no' }, { ref: refs[1], state: 'landed' }] as WatchState[],
  });
  const both = await answerDeclaredProbe({ slug: 'demo', phase: 4, file: stage(root, [PUSH, 'phase:demo/43']) }, { root, probe: mixed });
  assert.equal(both.status === 200 && both.verdict, 'landed', 'a wait that is already over is over');
});

test('DP-2: probeDeclared judges a cmd: ref by its shape and by the run policy WITHOUT running it; a self-naming phase ref is refused; a done sibling has landed', async () => {
  assert.ok(judgeCommand('git push origin main'), 'the run policy refuses a push');
  assert.equal(judgeCommand('test -f /tmp/p27/het-verify.rc'), null, 'and passes a read');
  const scheduler = schedulerWith();
  const answer = await scheduler.probeDeclared('demo', 4, [
    PUSH, "cmd:\"grep -q 'ios done' '$L'\"", 'cmd:"test -f ./out/sweep.rc"', 'phase:demo/4', 'verify:demo/9', 'phase:demo/43',
  ], { budgetMs: 2_000 });
  const by = new Map(answer.refs.map((r) => [r.ref, r]));
  assert.equal(by.get(PUSH)?.state, 'refused', 'the policy, with watchCmdRefs off');
  assert.match(by.get("cmd:\"grep -q 'ios done' '$L'\"")?.detail ?? '', /shell variable/);
  assert.match(by.get('cmd:"test -f ./out/sweep.rc"')?.detail ?? '', /relative path/);
  assert.equal(by.get('phase:demo/4')?.state, 'refused', 'a phase cannot wait for its own completion');
  assert.equal(by.get('verify:demo/9')?.state, 'refused', 'verify: names the declaring phase');
  assert.equal(answer.landed?.ref, 'phase:demo/43', 'a sibling already done has landed');
});

test('DP-3: the script hears the console refuse its ref and exits 2 with the reason — nothing is written', async () => {
  const root = repoRoot();
  const scheduler = schedulerWith();
  const service = {
    flags: {},
    probeDeclaration: (body: Record<string, unknown>) => answerDeclaredProbe(body, {
      root, probe: (slug, phase, refs) => scheduler.probeDeclared(slug, phase, refs, { budgetMs: 5_000 }),
    }),
  };
  const server: Server = createServer((req, res) => {
    void handleApi({ service } as never, req, res, new URL(`http://127.0.0.1${req.url}`)).then((handled) => {
      if (!handled) { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const file = join(runDir(root, 'demo'), 'run-abc123-p4-outcome.json');
    mkdirSync(runDir(root, 'demo'), { recursive: true });
    const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile('bash', [SCRIPT, 'demo', '4', 'waiting-external', '--wait-minutes', '30', '--watch', PUSH], {
        encoding: 'utf8', timeout: 60_000,
        env: {
          ...process.env, DOCS_ROOT: root, PE_OUTCOME_FILE: file, PHASE_OUTCOME_PROBE: '1',
          PHASE_CONSOLE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        },
      }, (error, _stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr }));
    });
    assert.equal(out.code, 2, out.stderr);
    assert.match(out.stderr, /refused — cmd:'git push origin main'/);
    assert.equal(existsSync(file), false, 'no declaration was written — nothing parks on a ref nothing can land');
    assert.deepEqual(readdirSync(runDir(root, 'demo')).filter((name) => name.includes('.tmp.')), [], 'the staged file is gone');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
