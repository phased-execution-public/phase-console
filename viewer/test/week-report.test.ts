/**
 * The week in numbers (control-tower phase 64, AUD-37, WR-1..17).
 *
 * `analysis/week-report.ts` measures what the autopilot-week audit measured,
 * and `--replay` re-derives four of those numbers with today's models. The
 * corpus is synthetic (`fixtures/week-report/build.mjs`): two runs of one
 * made-up console, every time an hour offset from 2026-01-05T00:00Z, so each
 * expectation below is worked out by hand from the corpus's own lines.
 */

import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPLAY_RULES, formatWeekReport, planFactsReader, weekReportFromDir, type ReplayRule, type WeekReport,
} from '../server/analysis/week-report.ts';
import { instanceId } from '../shared/instances.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(HERE, 'fixtures', 'week-report');
const RUNS = join(FIXTURE, 'runs', 'console-a');
const WEEK = { instance: 'console-a', since: '2026-01-05T00:00:00Z', until: '2026-01-12T00:00:00Z' };
const factsOf = planFactsReader(FIXTURE, join(REPO, 'scripts'));
const report = (replay: readonly ReplayRule[] = []): WeekReport => weekReportFromDir(RUNS, { ...WEEK, replay, factsOf });

const recorded = report();
const m = recorded.metrics;

/** The metrics a replay moved, in report order. */
function changed(before: WeekReport, after: WeekReport): string[] {
  const keys = Object.keys(before.metrics) as (keyof WeekReport['metrics'])[];
  return keys.filter((key) => JSON.stringify(before.metrics[key]) !== JSON.stringify(after.metrics[key]));
}

const target = (r: WeekReport, id: string): boolean | null => r.targets.find((t) => t.id === id)!.met;

test('WR-1 — down share per run, and what ended each stop', () => {
  // Run A lives 08:00→29:00 (21 h) and stops four times: a streak halt 11→13 and a
  // stop 20→21 ended by an operator's Start, a streak halt 17→18 relaunched by
  // converge, a credential halt 21.5→24.5 ended by a person. Run B lives 07:00→15:30
  // (8.5 h): a streak halt 10→11 (an older Start that names only `by: operator`) and
  // a plan-lint halt 13→13.5 healed by converge. Queue and session time never count.
  assert.deepEqual(m.down.runs, [
    { slug: 'plan-alpha', run: 'a1a1a1a1', lifeHours: 21, downHours: 7, share: 0.333 },
    { slug: 'plan-beta', run: 'b2b2b2b2', lifeHours: 8.5, downHours: 1.5, share: 0.176 },
  ]);
  assert.equal(m.down.lifeHours, 29.5);
  assert.equal(m.down.downHours, 8.5);
  assert.equal(m.down.share, 0.288);
  assert.deepEqual(m.down.endedBy, { person: 7, console: 1.5, 'wait-clock': 0, open: 0 });
});

test('WR-2 — avoidable down time with no new information, by cause', () => {
  // Both of run A's streak halts counted something today's rule does not (3 h); the
  // lint that printed nothing (0.5 h); the certificate "refusal" was an outage, and
  // run B's usage reading at 22:00 shows the API answering again — 22:00→24:30.
  // Run B's own streak was two distinct phases failed on their merits: not avoidable.
  assert.deepEqual(m.avoidable, { hours: 6, byCause: { streak: 3, 'lint-crash': 0.5, 'credential-latch': 2.5 } });
});

test('WR-3 — streak halts by cause', () => {
  // A's first counted a rescued command; its second one phase's spent wait budget
  // twice; B's was phases 6 and 8, each failed on its merits.
  assert.deepEqual(m.streakHalts, { total: 3, flagged: 2, byCause: { 'rescued-command': 1, 'repeated-phase': 1, 'wait-budget': 1 } });
});

test('WR-4 — verify-failed halts from rescued commands', () => {
  // A's phase 2 went red then green on its retry (rows with `code` and no `retry`, as
  // a pre-phase-45 runner wrote them); B's phase 8 was red on both attempts.
  assert.deepEqual(m.verifyFailed, { halts: 2, fromRescued: 1 });
});

test('WR-5 — phantom spend: booked against the CLI\'s own final total per session id', () => {
  // s-a2 reported 5, then — resumed — its running total 8: booked 13 for a session
  // that cost 8. s-b7's resume was booked by today's console (`bookedUsd: 2`).
  assert.deepEqual(m.spend, { sessions: 17, bookedUsd: 65.5, finalUsd: 60.5, phantomUsd: 5, phantomShare: 0.076, mismatched: 1 });
});

test('WR-6 — own-run share of queued time', () => {
  // A's phase 4 waited an hour behind A's own phase 3, and B's phase 7 an hour behind
  // B's own phase 6: 2 h of the 4.5 h queued.
  assert.equal(m.queue.ownRunHours, 2);
  assert.equal(m.queue.ownRunShare, 0.444);
});

test('WR-7 — the holder label against the realised wait: median and low-bound coverage', () => {
  // Three admitted waits carried a label, each realised in 1 h: "~1 d–2 d left" (the
  // whole-plan figure), "~2 h–4 h left" and "~30 min–1 h of work left". The label's
  // point is its band's geometric centre: 33.9 h, 2.83 h, 0.71 h.
  assert.deepEqual(m.holderEta, {
    waits: 3, medianRealisedOverLabel: 0.35, errorAtMedian: 2.83, medianLowOverRealised: 2, lowCoverage: 0.333, bandCoverage: 0.333,
  });
});

test('WR-8 — Σ recorded queue time against Σ episodes', () => {
  // Five episodes, 4.5 h: a withdrawal (0.5 h) and a boarding with no admission line
  // (1 h) recorded nothing; B's phase 8 wrote both `phase.queue-closed` and
  // `phase.admitted` for one wait, which is one episode and one hour.
  assert.equal(m.queue.episodes, 5);
  assert.equal(m.queue.episodeHours, 4.5);
  assert.equal(m.queue.recordedHours, 3);
  assert.equal(m.queue.recordedShare, 0.667);
  assert.equal(target(recorded, 'queue-recorded'), false);
});

test('WR-9 — phase ETA: the baseline, and the estimator only when replayed (it was never journalled)', () => {
  // Eleven phases began in the window with measured work (B's record-only phase 9 has none).
  assert.equal(m.phaseEta.records, 11);
  assert.equal(m.phaseEta.baseline.n, 11);
  assert.equal(m.phaseEta.estimator, null);
  assert.equal(m.phaseEta.ships, null);
  assert.equal(target(recorded, 'phase-eta'), null);
});

test('WR-10 — stall cards on finished lanes', () => {
  // A's phase 3 raised "silent" 36 s after its phase.done; phase 4's external-wait
  // stall came while it was still working and does not count.
  assert.deepEqual(m.stallsOnFinished, { count: 1, bySignal: { silent: 1 } });
});

test('WR-11 — resumes ending max_turns under a closeout cap', () => {
  // A's resume of phase 2 hit the 60-turn closeout cap; B's closeout session hit its
  // own cap, which is what a closeout is for.
  assert.deepEqual(m.closeoutCapResumes, { maxTurnsEndings: 2, underCloseoutCap: 1 });
});

test('WR-12 — phases closed with an unrun §Verification, from the journal and from the record', () => {
  assert.deepEqual(m.unrunVerification, {
    count: 2,
    phases: [{ slug: 'plan-alpha', run: 'a1a1a1a1', phase: 5 }, { slug: 'plan-beta', run: 'b2b2b2b2', phase: 9 }],
  });
  // And #91's check beside it: one start of nineteen ran on a model it did not name.
  assert.deepEqual(m.modelNamed, { starts: 19, differs: 1 });
});

test('SIZ-6 — context × calls: cache-read volume, mean context, the boot prefix\'s share', () => {
  // s-a1: 101 calls re-read 20 M tokens, booted at 100 K — 100 later calls × 100 K = 10 M
  // of it; s-a2: 51 calls, 5 M, booted at 80 K — 4 M. s-b5 predates `firstContext`: it
  // counts toward the volume and the mean, not toward the share. 30 M / 200 calls = 150 K;
  // 14 M of the 25 M measured = 0.56.
  assert.deepEqual(m.context, { sessions: 3, calls: 200, cacheReadMTokens: 30, meanContextK: 150, bootShare: 0.56, bootMeasured: 2 });
});

test('WR-13 — the streak rule (phase 45) moves the streak, its halts and the stops they made, and nothing else', () => {
  const replayed = report(['streak']);
  assert.deepEqual(changed(recorded, replayed), ['down', 'avoidable', 'streakHalts', 'verifyFailed']);
  const r = replayed.metrics;
  // Only B's distinct-phase streak halts today; A's two stops (3 h) never happen.
  assert.deepEqual(r.streakHalts, { total: 1, flagged: 0, byCause: { 'rescued-command': 0, 'repeated-phase': 0, 'wait-budget': 0 } });
  assert.deepEqual(r.verifyFailed, { halts: 1, fromRescued: 0 });
  assert.equal(r.down.downHours, 5.5);
  assert.deepEqual(r.down.endedBy, { person: 5, console: 0.5, 'wait-clock': 0, open: 0 });
  assert.deepEqual(r.avoidable, { hours: 3, byCause: { streak: 0, 'lint-crash': 0.5, 'credential-latch': 2.5 } });
  assert.equal(target(replayed, 'streak'), true);
  assert.equal(target(recorded, 'streak'), false);
});

test('WR-14 — the spend rule (phase 46) books what each running total added, and moves spend alone', () => {
  const replayed = report(['spend']);
  assert.deepEqual(changed(recorded, replayed), ['spend']);
  assert.deepEqual(replayed.metrics.spend, { sessions: 17, bookedUsd: 60.5, finalUsd: 60.5, phantomUsd: 0, phantomShare: 0, mismatched: 0 });
  assert.equal(target(replayed, 'phantom'), true);
  assert.equal(target(recorded, 'phantom'), false);
});

test('WR-15 — the ETA rule (phase 58) scores today\'s estimator against the same baseline, and moves the phase ETA alone', () => {
  const replayed = report(['eta']);
  assert.deepEqual(changed(recorded, replayed), ['phaseEta']);
  const eta = replayed.metrics.phaseEta;
  assert.deepEqual(eta.baseline, m.phaseEta.baseline, 'the baseline is model-free: a replay leaves it be');
  assert.equal(eta.estimator?.n, 11);
  assert.equal(eta.ships, eta.estimator!.within2 >= eta.baseline.within2 && eta.estimator!.male <= eta.baseline.male);
  assert.equal(target(replayed, 'phase-eta'), eta.ships);
});

test('WR-16 — the holder rule (phase 60) makes own-run waits serial, records every episode and relabels the holder', () => {
  const replayed = report(['holder']);
  assert.deepEqual(changed(recorded, replayed), ['queue', 'holderEta']);
  const r = replayed.metrics;
  // The 2 h behind each run's own lane are serial, not contention; the three other
  // episodes (2.5 h) each record their wait.
  assert.deepEqual(r.queue, {
    episodes: 3, episodeHours: 2.5, recordedHours: 2.5, recordedShare: 1, ownRunHours: 0, ownRunShare: 0, serialHours: 2,
  });
  // The admitted waits whose holder plan is on disk (plan-gamma is not): A's phase 4
  // behind A's phase 3, A's phase 7 behind B's phase 7 — each labelled with its
  // holder PHASE's remaining work at the moment it queued.
  assert.equal(r.holderEta.waits, 2);
  assert.ok(r.holderEta.errorAtMedian < m.holderEta.errorAtMedian, 'the phase label is nearer than the whole-plan one');
  for (const id of ['own-run', 'queue-recorded']) {
    assert.equal(target(replayed, id), true, id);
    assert.equal(target(recorded, id), false, id);
  }
});

test('WR-13..16 — all four rules together are the union of each, and --replay applies all four', () => {
  const all = report(REPLAY_RULES);
  assert.deepEqual(all.replay, ['streak', 'spend', 'eta', 'holder']);
  assert.deepEqual(changed(recorded, all), ['down', 'avoidable', 'streakHalts', 'verifyFailed', 'spend', 'queue', 'holderEta', 'phaseEta']);
  // The four counted off the journal as it stands are the same either way.
  for (const key of ['stallsOnFinished', 'closeoutCapResumes', 'unrunVerification', 'modelNamed', 'context'] as const) {
    assert.deepEqual(all.metrics[key], m[key], key);
  }
  const text = formatWeekReport(all);
  assert.match(text, /replayed with today's streak, spend, eta, holder models/);
  assert.match(text, /Item 10 targets/);
  assert.equal(text.split('\n').filter((line) => /^ {2}(met|missed|n\/a) /.test(line)).length, all.targets.length);
});

test('the window must be two instants in order', () => {
  assert.throws(() => weekReportFromDir(RUNS, { ...WEEK, until: WEEK.since }), /window/);
  assert.throws(() => weekReportFromDir(RUNS, { ...WEEK, since: 'last tuesday' }), /window/);
});

/** Every file under a directory, with its size and modification time. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      out[relative(dir, path)] = `${stat.size}:${stat.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

test('WR-17 — the verb reads and never writes, and both editions carry it', () => {
  const box = mkdtempSync(join(tmpdir(), 'week-report-'));
  const root = join(box, 'project');
  const state = join(box, 'state');
  cpSync(join(FIXTURE, 'docs'), join(root, 'docs'), { recursive: true });
  cpSync(RUNS, join(state, 'phase-console', 'runs', instanceId(root)), { recursive: true });
  const before = snapshot(state);
  const run = (...args: string[]) => spawnSync(process.execPath, [join(REPO, 'bin', 'phase-console.mjs'), 'report', '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(box, 'config'), PHASE_CONSOLE_SELF_UPDATE: '0' },
  });
  const json = run('--since', WEEK.since, '--until', WEEK.until, '--replay', '--json');
  assert.equal(json.status, 0, json.stderr);
  const printed = JSON.parse(json.stdout) as WeekReport;
  assert.deepEqual(printed.metrics, report(REPLAY_RULES).metrics, 'the verb prints the module\'s report');
  const text = run('--since', WEEK.since, '--until', WEEK.until);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Item 10 targets/);
  assert.equal(run('--until', WEEK.until).status, 2, '--since is required');
  assert.deepEqual(snapshot(state), before, 'nothing under the state directory was created or touched');

  // Both editions: the free bin dispatches it, neither file is a Pro path, both tarballs ship it.
  // Only the reads of Pro paths are marked: in the FREE tree the override is applied — the
  // `bin/phase-console.mjs` run above IS the free bin — and `free/` and the Pro tarball's gate do not ship.
  let freeBinPath = join(REPO, 'bin', 'phase-console.mjs');
  const freeBin = readFileSync(freeBinPath, 'utf8');
  assert.match(freeBin, /args\[0\] === 'report'[\s\S]{0,200}report-verb\.mjs/);
  const free = readFileSync(join(REPO, '.github', 'scripts', 'assert-tarball.sh'), 'utf8').split('!pro:start')[0]!;
  for (const file of ['bin/report-verb.mjs', 'viewer/server/analysis/week-report.ts']) assert.match(free, new RegExp(`"${file}"`), file);
});
