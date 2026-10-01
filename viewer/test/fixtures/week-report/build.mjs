// Builds the synthetic week `week-report.test.ts` replays (control-tower phase 64).
//
//     node viewer/test/fixtures/week-report/build.mjs
//
// Never the real journals — they carry account ids and paths. Two runs of one
// made-up console, `console-a`, laid out exactly as a state directory holds
// them (`runs/<instance>/<slug>/run-<id>.jsonl` and `.json`), plus the two plan
// files the ETA and holder models size phases from. Every time is an hour
// offset from 2026-01-05T00:00Z, so each number the test expects can be
// worked out by hand from the lines below; the test's comments do that.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const H = 3_600_000;
const BASE = Date.parse('2026-01-05T00:00:00.000Z');
const at = (hours) => new Date(BASE + Math.round(hours * H)).toISOString();

const session = (h, phase, sessionId, costUsd, hours, extra = {}) => [h, 'phase.session', phase, {
  mode: 'phase', sessionId, costUsd, costSource: 'result', ms: Math.round(hours * H),
  isError: false, subtype: 'success', terminalReason: 'completed', maxTurns: { value: 300, source: 'size', basis: 'M' }, ...extra,
}];
const green = (h, phase) => [h, 'phase.verify', phase, { ok: true, ran: [{ command: 'npm test', code: 0, ms: 180_000 }] }];
const waitingOn = (slug, phase, owner, label) => ({ scope: 'app', headKind: 'grant', waitingOn: [{ slug, phase, owner, overlaps: ['app'], ...(label ? { eta: { label } } : {}) }] });

// Run A — plan-alpha. Two failure-streak halts today's rule would not make, an
// operator's stop over a verification that never ran, and a credential halt
// that was really an outage.
const alpha = [
  [8, 'run.start', null, { door: 'operator', by: 'operator' }],
  [8, 'phase.start', 1, { model: 'claude-opus-5-5[1m]', effort: 'max' }],
  session(9, 1, 's-a1', 10, 1),
  [9, 'phase.tokens', 1, { mode: 'phase', sessionId: 's-a1', calls: 101, firstContext: 100_000, peakContext: 300_000, cacheRead: 20_000_000, cacheWrite: 400_000, input: 900, output: 40_000 }],
  green(9, 1),
  [9, 'phase.done', 1, {}],
  [9, 'phase.model-differs', 1, { asked: 'claude-opus-5-5[1m]', running: 'claude-opus-5[1m]' }],
  [9, 'phase.start', 2, {}],
  session(10, 2, 's-a2', 5, 1),
  [10, 'phase.tokens', 2, { mode: 'phase', sessionId: 's-a2', calls: 51, firstContext: 80_000, peakContext: 150_000, cacheRead: 5_000_000, cacheWrite: 200_000, input: 500, output: 20_000 }],
  // Red, then green on its retry: the verdict calls this rescued, and the old runner halted anyway.
  [10, 'phase.verify', 2, { ok: true, ran: [{ command: 'npm test', code: 1, ms: 180_000 }, { command: 'npm test', code: 0, ms: 180_000 }] }],
  [10, 'phase.halted', 2, { kind: 'verify-failed', reason: 'npm test failed' }],
  [10, 'phase.start', 3, {}],
  session(11, 3, 's-a3', 4, 1),
  [11, 'phase.halted', 3, { kind: 'no-handoff', reason: 'no handoff' }],
  [11, 'run.halt', null, { kind: 'failure-streak', reason: '2 phases failed in a row: phase 2, then phase 3' }],
  [13, 'run.start', null, { door: 'operator', by: 'operator' }],
  [13, 'phase.start', 2, {}],
  // The same session resumed: the CLI reports its running total, 8, which the old console booked whole.
  session(14, 2, 's-a2', 8, 1, { mode: 'resume', resumed: true, subtype: 'error_max_turns', terminalReason: 'max_turns', maxTurns: { value: 60, source: 'closeout' } }),
  green(14, 2),
  [14, 'phase.done', 2, {}],
  [14, 'phase.start', 3, {}],
  [14, 'phase.queued', 4, waitingOn('plan-alpha', 3, 'autopilot/a1a1a1a1', '~1 d–2 d left')],
  session(15, 3, 's-a3b', 6, 1),
  green(15, 3),
  [15, 'phase.done', 3, {}],
  [15, 'phase.admitted', 4, { scope: 'app', waitedMs: H }],
  [15, 'phase.start', 4, {}],
  [15.01, 'phase.stall', 3, { signal: 'silent', since: at(14.5) }],
  [15.5, 'phase.stall', 4, { signal: 'external-wait', since: at(15.4) }],
  session(16, 4, 's-a4', 3, 1),
  [16, 'phase.halted', 4, { kind: 'waiting-external-timeout', reason: 'the wait budget is spent' }],
  [16, 'phase.start', 4, {}],
  session(17, 4, 's-a4b', 2, 1),
  [17, 'phase.halted', 4, { kind: 'waiting-external-timeout', reason: 'the wait budget is spent' }],
  [17, 'run.halt', null, { kind: 'failure-streak', reason: '2 phases failed in a row: phase 4, then phase 4' }],
  [18, 'run.start', null, { door: 'converge-relaunch', by: 'converge' }],
  [18, 'phase.start', 4, {}],
  session(19, 4, 's-a4c', 2, 1),
  green(19, 4),
  [19, 'phase.done', 4, {}],
  [19, 'phase.start', 5, {}],
  session(20, 5, 's-a5', 3, 1),
  [20, 'phase.verify-stopped', 5, { ran: 0, notRun: 3, reason: 'the run was stopped mid-verification — 0 of 3 command(s) ran' }],
  [20, 'run.stop-requested', null, { by: 'operator' }],
  [21, 'run.start', null, { door: 'operator', by: 'operator' }],
  [21, 'phase.done', 5, {}],
  [21, 'phase.start', 6, {}],
  session(21.5, 6, 's-a6', 0.5, 0.5, { isError: true, subtype: 'error_during_execution', terminalReason: 'api_error' }),
  [21.5, 'run.halt', null, { kind: 'credential-refused', reason: 'the API refused the connection: a certificate this machine does not trust (a self-signed or intercepting certificate)' }],
  [24.5, 'run.start', null, { door: 'operator', by: 'operator' }],
  [24.5, 'phase.start', 6, {}],
  session(25.5, 6, 's-a6b', 4, 1),
  green(25.5, 6),
  [25.5, 'phase.done', 6, {}],
  [25.5, 'phase.queued', 7, waitingOn('plan-beta', 7, 'autopilot/b2b2b2b2', '~2 h–4 h left')],
  [26, 'run.halt-withdrew', null, { phases: [7] }],
  [27, 'phase.queued', 7, waitingOn('plan-beta', 7, 'autopilot/b2b2b2b2', '~2 h–4 h left')],
  [28, 'phase.admitted', 7, { scope: 'app', waitedMs: H }],
  [28, 'phase.start', 7, {}],
  session(29, 7, 's-a7', 3, 1),
  green(29, 7),
  [29, 'phase.done', 7, {}],
];

// Run B — plan-beta. History before the window (the ETA's priors), a real
// streak of two distinct phases, a lint that proved nothing, a queue closed
// the new way, a wait nothing recorded, and the usage reading that shows the
// API answering again during run A's credential halt.
const beta = [
  [-72, 'run.start', null, { door: 'operator', by: 'operator' }],
  [-72, 'phase.start', 1, {}],
  session(-71, 1, 's-b1', 2, 1),
  green(-71, 1),
  [-71, 'phase.done', 1, {}],
  [-71, 'phase.start', 2, {}],
  session(-69, 2, 's-b2', 4, 2),
  green(-69, 2),
  [-69, 'phase.done', 2, {}],
  [-69, 'phase.start', 3, {}],
  session(-68.5, 3, 's-b3', 1, 0.5),
  green(-68.5, 3),
  [-68.5, 'phase.done', 3, {}],
  [-68.5, 'phase.start', 4, {}],
  session(-67, 4, 's-b4', 3, 1.5),
  green(-67, 4),
  [-67, 'phase.done', 4, {}],
  [-67, 'run.finished', null, {}],
  [7, 'run.start', null, { door: 'operator', by: 'operator' }],
  [7, 'phase.start', 5, {}],
  session(8, 5, 's-b5', 2, 1),
  // Written before phase 59: no firstContext.
  [8, 'phase.tokens', 5, { mode: 'phase', sessionId: 's-b5', calls: 48, peakContext: 120_000, cacheRead: 5_000_000, cacheWrite: 100_000, input: 400, output: 10_000 }],
  green(8, 5),
  [8, 'phase.done', 5, {}],
  [8, 'phase.start', 6, {}],
  [8, 'phase.queued', 8, waitingOn('plan-gamma', 2, 'autopilot/c3c3c3c3', '~30 min–1 h of work left')],
  session(9, 6, 's-b6', 2, 1),
  [9, 'phase.halted', 6, { kind: 'no-handoff', reason: 'no handoff' }],
  [9, 'phase.queue-closed', 8, { outcome: 'admitted', ms: H, waitedMs: H }],
  [9, 'phase.admitted', 8, { scope: 'app', waitedMs: H }],
  [9, 'phase.start', 8, {}],
  session(10, 8, 's-b8', 2, 1),
  [10, 'phase.verify', 8, { ok: false, ran: [{ command: 'npm test', code: 1, ms: 180_000 }, { command: 'npm test', code: 1, ms: 180_000 }] }],
  [10, 'phase.halted', 8, { kind: 'verify-failed', reason: 'npm test failed' }],
  [10, 'run.halt', null, { kind: 'failure-streak', reason: '2 phases failed in a row: phase 6, then phase 8' }],
  [11, 'run.start', null, { by: 'operator' }],
  [11, 'phase.start', 6, {}],
  [11, 'phase.queued', 7, waitingOn('plan-beta', 6, 'autopilot/b2b2b2b2')],
  session(12, 6, 's-b6b', 2, 1, { mode: 'closeout', subtype: 'error_max_turns', terminalReason: 'max_turns', maxTurns: { value: 60, source: 'closeout' } }),
  green(12, 6),
  [12, 'phase.done', 6, {}],
  [12, 'phase.start', 7, {}],
  session(13, 7, 's-b7', 3, 1),
  [13, 'run.halt', null, { kind: 'plan-lint', reason: 'phase 6 left the plan failing validate.sh: ' }],
  [13.5, 'run.start', null, { door: 'converge-heal', by: 'heal' }],
  [13.5, 'phase.start', 7, {}],
  // A resume written by today's console: it books only what the running total added.
  session(14.5, 7, 's-b7', 5, 1, { mode: 'resume', resumed: true, bookedUsd: 2 }),
  green(14.5, 7),
  [14.5, 'phase.done', 7, {}],
  [14.5, 'phase.start', 8, {}],
  session(15.5, 8, 's-b8b', 2, 1),
  green(15.5, 8),
  [15.5, 'phase.done', 8, {}],
  [22, 'run.usage-window', null, { kind: 'limits', status: 'allowed', window: 'five_hour', utilization: 0.2 }],
];

/** The run record the console would have checkpointed: each finished phase's first boarding and its end. */
function record(id, slug, lines, extra = {}) {
  const phases = {};
  for (const [h, event, phase] of lines) {
    if (phase == null) continue;
    const entry = phases[phase] ??= { phase, status: 'pending' };
    if (event === 'phase.start') {
      entry.startedAt ??= at(h);
      entry.attemptStartedAt = at(h);
    }
    if (event === 'phase.done') Object.assign(entry, { status: 'done', endedAt: at(h), attemptEndedAt: at(h) });
  }
  return { id, slug, status: 'finished', maxConsecutiveFailures: 2, phases: { ...phases, ...extra } };
}

const journal = (lines) => lines
  .map(([h, event, phase, data], i) => JSON.stringify({ seq: i + 1, time: at(h), event, ...(phase == null ? {} : { phase }), data }))
  .join('\n') + '\n';

const plan = (slug, sizes) => [
  '---', `slug: ${slug}`, 'status: active', '---', '', `# ${slug}`, '', '## Phase graph', '',
  '| Phase | Title | Depends on | Repos | Exit criteria |',
  '|------:|-------|-----------|-------|---------------|',
  ...sizes.map((_, i) => `| ${i + 1} | Step ${i + 1} | ${i ? i : '—'} | app | done |`),
  '',
  ...sizes.flatMap((size, i) => [`### Phase ${i + 1} — Step ${i + 1}`, `- **Size:** ${size}`, '']),
].join('\n');

const runs = join(HERE, 'runs', 'console-a');
rmSync(join(HERE, 'runs'), { recursive: true, force: true });
rmSync(join(HERE, 'docs'), { recursive: true, force: true });
const write = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
write(join(runs, 'plan-alpha', 'run-a1a1a1a1.jsonl'), journal(alpha));
write(join(runs, 'plan-alpha', 'run-a1a1a1a1.json'), `${JSON.stringify(record('a1a1a1a1', 'plan-alpha', alpha), null, 2)}\n`);
write(join(runs, 'plan-beta', 'run-b2b2b2b2.jsonl'), journal(beta));
write(join(runs, 'plan-beta', 'run-b2b2b2b2.json'), `${JSON.stringify(record('b2b2b2b2', 'plan-beta', beta, {
  // Closed done by a reconcile after a restart cut its verification: no journal line says so, only the record.
  9: { phase: 9, status: 'done', startedAt: at(14.9), endedAt: at(15), verification: { ok: false, reason: 'the run was stopped mid-verification — 0 of 2 command(s) ran', ran: [], notRun: [{ command: 'npm test' }, { command: 'npm run lint' }] } },
}), null, 2)}\n`);
write(join(HERE, 'docs', 'plans', 'plan-alpha.md'), plan('plan-alpha', ['M', 'M', 'S', 'L', 'M', 'M', 'S']));
write(join(HERE, 'docs', 'plans', 'plan-beta.md'), plan('plan-beta', ['S', 'M', 'S', 'M', 'M', 'M', 'L', 'M', 'S']));
