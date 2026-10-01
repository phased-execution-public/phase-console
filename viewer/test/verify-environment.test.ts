/**
 * The machine, not the work: an `environment` verification outcome
 * (control-tower phase 89, #41's 2026-09-25 06:11Z comment).
 *
 * 26 records across four plans were permanent `verification.ok: false` on
 * phases whose work was complete, every one environmental on audit: a
 * `PRECONDITION FAILED` naming another plan's Metro log (retried twice,
 * unchanged), a refused connection to the port the phase's own `next start`
 * had served on until its session ended, a command the shell could not find.
 *
 * EV-1  an exit 127, a named `PRECONDITION` line, and a refused connection to a
 *       port the phase's own session served on are `environment` — never
 *       retried, and the verdict reads them `unproven`, not red; a refusal on a
 *       port the session never served on stays red
 * EV-2  a phase whose only failing lines are environmental settles on its work:
 *       no streak charge, no re-open, the record saying UNPROVEN and why
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import * as verifyModule from '../server/runner/verify.ts';
import * as liveness from '../server/runner/liveness.ts';
import { Runner } from '../server/runner/runner.ts';
import type { VerifyOptions } from '../server/runner/verify.ts';
import { streakPhases, type VerifySummary } from '../server/runner/state.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

// Namespace reads, so this file loads on a tree that has none of it: each
// assertion then fails on its own rather than the whole file on an import.
const environmentOf = (row: { ok: boolean; code: number; output: string; timedOut?: boolean }, ports?: number[]): string | null =>
  (verifyModule as unknown as { environmentOf?: typeof environmentOf }).environmentOf?.(row, ports) ?? null;
const servedPorts = (summary: string): number[] =>
  (liveness as unknown as { servedPorts?: (s: string) => number[] }).servedPorts?.(summary) ?? [];

test('EV-1: an exit 127, a PRECONDITION line and a refusal on the session\'s own port are the machine\'s — a foreign port is not', () => {
  assert.match(environmentOf({ ok: false, code: 127, output: 'bash: sweep-all-roles.sh: command not found' }) ?? '', /exit 127/);
  assert.match(
    environmentOf({ ok: false, code: 1, output: 'booting\nPRECONDITION FAILED: Metro already serving on :8081 but METRO_LOG (/tmp/x/metro-ios.log) empty\n' }) ?? '',
    /precondition failed: PRECONDITION FAILED: Metro already serving/,
  );
  const refused = { ok: false, code: 1, output: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8151/vendor' };
  assert.match(environmentOf(refused, [8151]) ?? '', /connection refused on :8151, a port the phase's own session served on/);
  assert.equal(environmentOf(refused, [3000]), null, 'a server the session never ran is not its own');
  assert.equal(environmentOf(refused), null);
  assert.equal(environmentOf({ ok: false, code: 1, output: 'not ok 1 - a real assertion' }), null, 'an ordinary red stays red');
  assert.equal(environmentOf({ ok: false, code: 124, output: 'PRECONDITION', timedOut: true }), null, 'a cut is verify-timeout\'s');
  // Which ports a session serves on — never a port it merely probes.
  assert.deepEqual(servedPorts('pnpm --filter shop next start -p 8151 > /tmp/next.log 2>&1 &'), [8151]);
  assert.deepEqual(servedPorts('PORT=4000 node server.js &'), [4000]);
  assert.deepEqual(servedPorts('python3 -m http.server 8000 &'), [8000]);
  assert.deepEqual(servedPorts('curl -sf http://localhost:8151/health'), []);
});

test('EV-1: the verifier never retries an environmental failure, and its verdict is unproven, not red', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-ev-')));
  TRASH.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'pre.sh'), '#!/bin/bash\necho "PRECONDITION FAILED: the dev database is at p85"\nexit 1\n', { mode: 0o755 });
  const summary = await verifyModule.verifyPhase('- `bash pre.sh`', { cwd: dir, timeoutMs: 30_000 });
  assert.equal(summary.ok, false);
  assert.equal(summary.ran.length, 1, 'an unchanged precondition is not run again');
  assert.match(summary.ran[0]!.environment ?? '', /precondition failed/);
  assert.deepEqual(summary.unproven?.map((row) => row.command), ['bash pre.sh']);
  assert.match(summary.reason, /could not be judged here — .*unproven, not a red/);
  const verdict = verifyModule.verificationVerdict(summary.ran) as { broke: unknown[]; unproven?: unknown[] };
  assert.equal(verdict.broke.length, 0, 'not a red');
  assert.equal(verdict.unproven?.length, 1);

  writeFileSync(join(dir, 'miss.sh'), '#!/bin/bash\nno-such-command-p89\n', { mode: 0o755 });
  const missing = await verifyModule.verifyPhase('- `bash miss.sh`', { cwd: dir, timeoutMs: 30_000 });
  assert.equal(missing.ran.length, 1, 'a 127 is not retried either');
  assert.match(missing.ran[0]!.environment ?? '', /exit 127/);
});

test('EV-2: a phase whose only failing line is environmental settles on its work — unproven, never charged, never re-opened', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-ev-run-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done\n');
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) if [ -f "${root}/.done" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const LINE = 'pnpm e2e';
  const calls: string[] = [];
  const runner = new Runner({
    scriptsDir: scripts,
    spawn: async () => {
      writeFileSync(join(root, '.done'), '');
      return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
    },
    verify: async (_text: string, opts: VerifyOptions): Promise<VerifySummary> => {
      calls.push(opts.purpose ?? 'verify');
      const row = { command: LINE, ok: false, code: 1, ms: 5, output: 'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8151/', environment: 'connection refused on :8151, a port the phase\'s own session served on — it stopped with the session' };
      return {
        ok: false, reason: `\`${LINE}\` could not be judged here — ${row.environment} (unproven, not a red)`, notRun: [], ran: [row],
        unproven: [{ command: LINE, why: row.environment }],
      } as VerifySummary;
    },
    verificationText: () => `\`${LINE}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: true });
  await runner.wait();

  const record = state.phases['1'];
  assert.equal(record.status, 'done', `settled on its work (${record.note ?? ''})`);
  assert.equal(record.reopened, undefined, 'never re-opened');
  assert.deepEqual(streakPhases(state), [], 'never charged');
  assert.equal(state.halt ?? null, null, 'no halt');
  assert.match(record.note ?? '', /UNPROVEN — connection refused on :8151/);
  assert.deepEqual(record.verification?.unproven?.map((row) => row.command), [LINE]);
  assert.deepEqual(calls, ['verify'], 'one pass, no fix rung');
});
