/**
 * The errand's "watching" sentence is derived from the live watch state wherever it is shown
 * (control-tower phase 88, #125).
 *
 * Measured on hub 4123 on 2026-09-25 (observability-plane P27): the errand was composed at
 * 09:08:59, before the scheduler's first probe, when `watchState` had no row for the ref, and
 * `watchSummary()` counted a ref with no row as `live`. So `errand.how` froze "The console is
 * watching one live ref (…) and resumes the session when one lands". The probe refused the ref
 * three seconds later; the halt re-issued 69 minutes after that still said it was being watched.
 *
 * WF-4  a ref with no row is `unknown`, never `live` — and a clause over it never promises a resume
 * WF-5  the runner stores the errand's own words and marks the sentence as live; every reader
 *       derives it from the record NOW, and when every ref is refused it says "do the errand, then
 *       press Retry on phase N"
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { Errand, PhaseRecord, RunState } from '../server/runner/state.ts';
import { liveErrandHow, watchClause, watchSummary, withLiveErrands } from '../server/watch-refs.ts';

/** P27's ref, whole this time — the cut is the script's half of #125. */
const REF = 'cmd:"test -f /tmp/p27/het-verify.rc"';

type Rec = Pick<PhaseRecord, 'declared' | 'watch' | 'watchState' | 'watchRetired'>;

function recordWith(rows: { ref: string; state: string; detail?: string }[] = [], retired: string[] = []): Rec {
  return {
    declared: { status: 'needs-human', watch: [REF], at: '2026-09-25T09:08:58Z' },
    watchState: { at: '2026-09-25T09:09:02Z', refs: rows.map((r) => ({ ...r, scheme: 'cmd', checkedAt: '2026-09-25T09:09:02Z' })) } as never,
    ...(retired.length ? { watchRetired: retired } : {}),
  };
}

test('WF-4: a declared ref with no row yet is UNKNOWN, not live — the clause never promises a resume over it', () => {
  const summary = watchSummary(recordWith());
  assert.deepEqual(summary.live, [], 'nothing has been asked yet');
  assert.deepEqual(summary.unknown, [REF]);
  const clause = watchClause(summary, 27);
  assert.doesNotMatch(clause, /resumes the session when one lands/, 'no claim the probe has not earned');
  assert.match(clause, /no answer yet/);

  // A row that could not be answered is unknown too — `watchMintedCmdRefs` off, no `gh` auth.
  const held = watchSummary(recordWith([{ ref: REF, state: 'unknown', detail: 'cmd refs are not being run' }]));
  assert.deepEqual(held.live, []);
  assert.deepEqual(held.unknown, [REF]);

  // Only a PENDING row is live.
  const pending = watchSummary(recordWith([{ ref: REF, state: 'pending', detail: 'exit 1' }]));
  assert.deepEqual(pending.live, [REF]);
  assert.match(watchClause(pending, 27), /watching one live ref .* resumes the session when one lands/);
});

test('WF-5: every ref refused — the clause says do the errand, then press Retry on phase N', () => {
  const refused = watchSummary(recordWith([{ ref: REF, state: 'refused', detail: 'unbalanced quoting' }], [REF]));
  assert.deepEqual(refused.refused.map((r) => r.ref), [REF]);
  const clause = watchClause(refused, 27);
  assert.match(clause, /nothing will resume it by itself/);
  assert.match(clause, /do the errand, then press Retry on phase 27/);
  assert.doesNotMatch(clause, /watching/);
});

test('WF-5: the errand is stored without the sentence and every reader derives it from the record as it is NOW', () => {
  const errand: Errand = {
    phase: 27, situation: 'blocked-declared:permission', tried: [], at: '2026-09-25T09:08:59Z',
    need: 'Run the two Terraform applies.', how: 'Run them, then answer the card.', watching: true,
  };
  const record = recordWith() as PhaseRecord;
  // At the park: no row yet — nothing claimed.
  assert.doesNotMatch(liveErrandHow(errand, record), /resumes the session/);
  // The first probe refuses it: the SAME errand now says so, with nothing rewritten.
  record.watchState = recordWith([{ ref: REF, state: 'refused', detail: 'unbalanced quoting' }]).watchState;
  record.watchRetired = [REF];
  const now = liveErrandHow(errand, record);
  assert.ok(now.startsWith('Run them, then answer the card.'), 'the errand\'s own words first');
  assert.match(now, /do the errand, then press Retry on phase 27/);
  assert.equal(errand.how, 'Run them, then answer the card.', 'the stored words are untouched');

  // The API projection every page reads carries the derived sentence — on a copy.
  const run = { slug: 'demo', phases: { '27': record }, recoveries: { '27': { attempts: 0, lastAt: errand.at, errand } } } as unknown as RunState;
  const seen = withLiveErrands(run);
  assert.match(seen.recoveries!['27']!.errand!.how, /press Retry on phase 27/);
  assert.equal(run.recoveries!['27']!.errand!.how, 'Run them, then answer the card.', 'the stored run is not mutated');

  // An errand that never named refs is shown exactly as written.
  const plain: Errand = { ...errand, watching: undefined };
  assert.equal(liveErrandHow(plain, record), plain.how);
});

test('WF-5: the runner\'s needs-human park stores the errand\'s words and marks the watch sentence live — it freezes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-errand-live-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
    writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
    const runner = new Runner({
      scriptsDir,
      spawn: async (req: { env?: Record<string, string> }) => {
        writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
          version: 1, slug: 'demo', phase: 1, status: 'needs-human', needs: 'permission',
          reason: 'Nothing merges before the operator runs the two Terraform applies.',
          watch: [REF], written_at: new Date().toISOString(), session_id: 'sid-1',
        }));
        return { signal: { subtype: 'success', code: 0, text: 'done' }, sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going' } as never);
    await runner.wait();
    const errand = state.recoveries?.['1']?.errand;
    assert.ok(errand, 'the person was asked');
    assert.equal(errand!.watching, true, 'the sentence is marked live');
    assert.doesNotMatch(errand!.how, /watching|resumes the session/i, 'and none of it is frozen into the stored words');
    assert.doesNotMatch(state.halt?.reason ?? '', /resumes the session when one lands/, 'nor into the halt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
