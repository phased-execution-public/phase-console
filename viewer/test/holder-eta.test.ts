/**
 * A holder's ETA is the holder PHASE's remaining estimate (control-tower phase
 * 60, #63 — HE-1..3).
 *
 * The queue card's "they have ~5.5 d–11 d left" was the holder's WHOLE-PLAN
 * remaining time: 24.7× the realised wait at the median, and in 67 of 78 cards
 * the waiter's own plan — so the figure counted the waiter itself and every
 * phase after it. The scope is released when the holder PHASE ends.
 *
 *   HE-1  the figure is that phase's estimate (phase 58's model) minus what it
 *         has already worked, never under a measured residual, naming its clock;
 *   HE-2  the scheduler asks for the holder's PHASE, and a plan-level figure —
 *         only where no phase is known — is labelled `plan remaining`;
 *   HE-3  on the committed corpus of this machine's admitted waits, the
 *         realised wait ÷ the label is ≤ 2× at the median.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { holderRemaining, HOLDER_RESIDUAL_FRACTION } = await import('../server/analysis/stats.ts');
const { scoreWaits, holderWaitsFromRuns, anonymiseWaits } = await import('../server/analysis/holder-eta.ts');
const { Scheduler, autopilotOwner, planRemainingEta } = await import('../server/runner/scheduler.ts');
import type { HolderWait } from '../server/analysis/holder-eta.ts';
import type { HolderEta, LockView } from '../server/runner/scheduler.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* ================================================================== *
 * HE-1
 * ================================================================== */

test('HE-1: a holder phase has its estimate less what it has worked, in a band, naming its clock', () => {
  const fresh = holderRemaining(90 * MIN, 0.8, 0);
  assert.equal(fresh.remainingMs, 90 * MIN, 'nothing worked yet: the whole phase');
  assert.equal(fresh.overrun, false);
  assert.ok(fresh.lowMs < fresh.remainingMs && fresh.highMs > fresh.remainingMs);
  assert.match(fresh.label, /^~.+ of work left$/, 'working time, said so — never a bare countdown');

  const half = holderRemaining(90 * MIN, 0.8, 30 * MIN);
  assert.equal(half.remainingMs, 60 * MIN, 'an hour of a ninety-minute phase is left after thirty');

  const late = holderRemaining(90 * MIN, 0.8, 80 * MIN);
  assert.equal(late.remainingMs, 90 * MIN * HOLDER_RESIDUAL_FRACTION, 'near its end it is given the residual, not ten minutes');
  assert.equal(late.overrun, false);

  const over = holderRemaining(60 * MIN, 0.8, 3 * HOUR);
  assert.equal(over.overrun, true, 'past its estimate');
  assert.equal(over.remainingMs, 60 * MIN * HOLDER_RESIDUAL_FRACTION, 'still a figure — "0 min left" was the one certain-wrong answer');
  assert.match(over.label, /past its estimate/);
});

test('HE-1: the label is a range a person would say out loud', () => {
  // 40 min ÷ 1.8 ≈ 22 min → 20 min; 40 min × 1.8 = 72 min → 1 h.
  assert.equal(holderRemaining(40 * MIN, 0.8, 0).label, '~20 min–1 h of work left');
});

/* ================================================================== *
 * HE-2
 * ================================================================== */

test('HE-2: the scheduler asks for the holder PHASE — grant, lock and reservation alike', async () => {
  const asked: [string, number | null][] = [];
  const etaFor = (slug: string, phase: number | null): HolderEta => {
    asked.push([slug, phase]);
    return { of: 'phase', label: `P${phase} of ${slug}`, remainingMs: 30 * MIN };
  };
  const lock: LockView = { slug: 'handplan', phase: 8, owner: 'someone@laptop', expired: false, scope: ['b'], leaseUntil: Date.now() + HOUR };
  const s = new Scheduler({ max: 4, etaFor, locks: () => [lock] });
  const lane = await s.admit({ slug: 'demo', phase: 3, runId: 'aaaaaaaaaaaa', scope: ['a'] });
  const own = s.admit({ slug: 'demo', phase: 4, runId: 'aaaaaaaaaaaa', scope: ['a'] });
  const onHand = s.admit({ slug: 'demo', phase: 9, runId: 'aaaaaaaaaaaa', scope: ['b'] });
  for (const p of [own, onHand]) p.catch(() => {});
  await tick();
  const entries = s.snapshot().entries;
  const holderOf = (phase: number) => entries.find((e) => e.phase === phase)!.waitingOn[0]!;
  assert.equal(holderOf(4).eta?.label, 'P3 of demo', 'an own-run holder: that PHASE, which excludes the waiter and every phase after it');
  assert.equal(holderOf(9).eta?.label, 'P8 of handplan', 'a lock: its phase');
  assert.ok(asked.every(([, phase]) => phase != null), 'every holder with a phase is asked by its phase');
  s.release(lane);
  s.close();
});

test('HE-2: a plan-level figure — only where no phase is known — is labelled `plan remaining`', async () => {
  assert.deepEqual(
    planRemainingEta({ remainingWeight: 3_850_000, label: '~1.8 d–5.3 d of work left' }),
    { remainingWeight: 3_850_000, label: 'plan remaining ~1.8 d–5.3 d of work', of: 'plan' },
  );
  assert.equal(planRemainingEta({ label: 'plan remaining ~2 h of work' })?.label, 'plan remaining ~2 h of work', 'never twice');
  assert.equal(planRemainingEta(undefined), undefined, 'nothing known stays nothing');
  // …and the scheduler asks with a null phase only for a holder that names none.
  const asked: [string, number | null][] = [];
  const s = new Scheduler({
    max: 4,
    etaFor: (slug, phase) => { asked.push([slug, phase]); return undefined; },
    locks: () => [],
  });
  const lane = await s.admit({ slug: 'demo', phase: 1, runId: 'aaaaaaaaaaaa', scope: ['a'] });
  const behind = s.admit({ slug: 'else', phase: 2, runId: 'bbbbbbbbbbbb', scope: ['a'] });
  behind.catch(() => {});
  await tick();
  assert.deepEqual(asked, [['demo', 1]]);
  s.release(lane);
  s.close();
});

/* ================================================================== *
 * HE-3 — the back-test
 * ================================================================== */

const corpus = JSON.parse(readFileSync(new URL('./fixtures/eta/holder-waits.json', import.meta.url), 'utf8')) as { waits: HolderWait[] };

test('HE-3: on the committed corpus the realised wait ÷ the label is at most 2× at the median', () => {
  assert.ok(corpus.waits.length >= 100, `a corpus worth scoring (${corpus.waits.length} waits)`);
  const score = scoreWaits(corpus.waits);
  assert.ok(score.medianRealisedOverLabel <= 2, `median realised ÷ label ${score.medianRealisedOverLabel.toFixed(2)}`);
  assert.ok(score.medianRealisedOverLabel >= 0.5, `…and not a label that overshoots instead (${score.medianRealisedOverLabel.toFixed(2)})`);
  // The plan-level label it replaces was 24.7× the real wait at the median; a
  // phase-level one must be an order of magnitude closer by the audit's own measure.
  assert.ok(score.male < 1.5, `MALE ${score.male.toFixed(3)}`);
  assert.ok(score.bandCoverage > 0.3, `band coverage ${(score.bandCoverage * 100).toFixed(1)} %`);
  const own = scoreWaits(corpus.waits.filter((wait) => wait.own));
  assert.ok(own.n > 0 && own.medianRealisedOverLabel <= 2, `own-run holders too (${own.medianRealisedOverLabel.toFixed(2)})`);
});

test('HE-3: the corpus names nobody', () => {
  for (const wait of corpus.waits) {
    assert.match(wait.instance, /^console-[a-z]$/);
    assert.match(wait.plan, /^plan-\d{2}$/);
  }
});

test('HE-3: an admitted wait is read from a journal with the holder’s worked time at the moment it queued', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-holder-eta-'));
  try {
    const dir = join(root, 'demo');
    mkdirSync(dir, { recursive: true });
    const run = '0123456789ab';
    const at = (m: number): string => new Date(Date.parse('2026-09-20T10:00:00Z') + m * MIN).toISOString();
    const lines = [
      // Phase 3's first session: 30 minutes, ended at 10:30.
      { time: at(30), event: 'phase.session', phase: 3, data: { mode: 'phase', ms: 30 * MIN } },
      // Phase 4 queues behind it at 10:40; 20 minutes of phase 3 later, it is admitted.
      { time: at(40), event: 'phase.queued', phase: 4, data: { waitingOn: [{ slug: 'demo', phase: 3, owner: autopilotOwner(run) }] } },
      { time: at(60), event: 'phase.admitted', phase: 4, data: { waitedMs: 20 * MIN } },
      // A wait a halt withdrew is not a sample.
      { time: at(61), event: 'phase.queued', phase: 5, data: { waitingOn: [{ slug: 'demo', phase: 3, owner: autopilotOwner(run) }] } },
      { time: at(62), event: 'run.halt-withdrew', data: {} },
      { time: at(90), event: 'phase.admitted', phase: 5, data: {} },
    ];
    writeFileSync(join(dir, `run-${run}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const facts = new Map([[3, { size: 'M' as const, weight: 40_000 }], [4, { size: 'S' as const, weight: 15_000 }]]);
    const waits = holderWaitsFromRuns(root, 'pe-hub', (slug) => (slug === 'demo' ? facts : null));
    assert.equal(waits.length, 1, 'one admitted wait; the withdrawn one is not a sample');
    const wait = waits[0]!;
    assert.equal(wait.waitedMs, 20 * MIN);
    assert.equal(wait.workedMs, 30 * MIN, 'what phase 3 had worked when phase 4 queued');
    assert.equal(wait.own, true);
    assert.ok(wait.estimateMs > 0);
    const [named] = anonymiseWaits(waits);
    assert.deepEqual([named!.instance, named!.plan], ['console-a', 'plan-01']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
