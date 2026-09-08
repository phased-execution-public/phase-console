/**
 * The Runs live strip: buckets through the one status vocabulary, a clock that
 * ticks only for what is genuinely moving, and a reason on every lane that is
 * not. Pure props — no api mock, the page hands it `nowLanes()` output.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveStrip, laneNote, stripBuckets } from './live-strip';
import type { NowLane } from '@/features/now/model';

const lane = (over: Partial<NowLane>): NowLane => ({
  key: `r1#${over.phase ?? 1}`,
  slug: 'demo',
  planTitle: 'Demo',
  runId: 'r1',
  phase: 1,
  status: 'running',
  runStatus: 'running',
  costUsd: 0.42,
  attempts: 1,
  frozen: false,
  enriched: false,
  ...over,
});

describe('stripBuckets', () => {
  it('buckets every lane through the status vocabulary — gated and parked are needs-you, never waiting', () => {
    const buckets = stripBuckets([
      lane({ phase: 1, status: 'running' }),
      lane({ phase: 2, status: 'verifying' }),
      lane({ phase: 3, status: 'gated' }),
      lane({ phase: 4, status: 'parked' }),
      lane({ phase: 5, status: 'awaiting-verification' }),
      lane({ phase: 6, status: 'waiting' }),
      lane({ phase: 7, status: 'queued' }),
      lane({ phase: 8, status: 'failed' }),
    ]);
    expect(buckets.running.map((l) => l.phase)).toEqual([1]);
    expect(buckets.verifying.map((l) => l.phase)).toEqual([2]);
    expect(buckets['needs-you'].map((l) => l.phase)).toEqual([3, 4, 5]);
    expect(buckets.waiting.map((l) => l.phase)).toEqual([6]);
    expect(buckets.queued.map((l) => l.phase)).toEqual([7]);
    expect(buckets.failed.map((l) => l.phase)).toEqual([8]);
  });

  it('a word this build has never heard of is misfiled gently, not dropped', () => {
    const buckets = stripBuckets([lane({ status: 'some-future-word' })]);
    const total = Object.values(buckets).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(1);
  });
});

describe('laneNote', () => {
  // relativeTime reads the real clock, so the fixtures are derived from it.
  const now = Date.now();
  const iso = (plusMs: number) => new Date(now + plusMs).toISOString();

  it('says what a queued lane is behind and when a parked one wakes', () => {
    expect(laneNote(lane({ status: 'queued', lockWaitSince: iso(-4 * 60_000) }), now)).toMatch(
      /queued behind a lock since 4 minutes ago/,
    );
    expect(laneNote(lane({ status: 'queued' }), now)).toBe('queued');
    expect(
      laneNote(lane({ status: 'waiting', parkedUntil: iso(30 * 60_000), parkReason: 'external clock' }), now),
    ).toMatch(/parked 30:00 more — external clock/);
    expect(laneNote(lane({ status: 'waiting' }), now)).toBe('waiting');
  });

  it('a needs-you lane keeps its own status word — gated explains itself', () => {
    expect(laneNote(lane({ status: 'gated' }), now)).toBe('gated');
  });
});

describe('LiveStrip', () => {
  it('renders nothing at all when no lane exists — the page subtitle already covers idle', () => {
    const { container } = render(<LiveStrip lanes={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('draws a ticking clock and a heartbeat only for a lane that is running', () => {
    render(
      <LiveStrip
        lanes={[
          lane({
            phase: 1,
            status: 'running',
            startedAt: new Date(Date.now() - 65_000).toISOString(),
            liveness: {
              phase: 1,
              lastOutputAt: new Date().toISOString(),
              turnsSinceLastTool: 0,
              commitsSinceStart: 0,
              treeDirty: false,
            },
            model: 'opus',
            effort: 'max',
          }),
          lane({ phase: 2, status: 'queued' }),
        ]}
      />,
    );
    const strip = screen.getByTestId('live-strip');
    expect(strip).toBeTruthy();
    // The running lane gets the full row: a <time> element carries the elapsed.
    const full = screen.getAllByTestId('strip-lane');
    expect(full).toHaveLength(1);
    expect(full[0].querySelector('time')).toBeTruthy();
    expect(full[0].textContent).toContain('opus');
    // The queued lane gets one honest line, no clock.
    const waitRows = screen.getAllByTestId('strip-wait');
    expect(waitRows).toHaveLength(1);
    expect(waitRows[0].querySelector('time')).toBeFalsy();
    expect(waitRows[0].textContent).toContain('queued');
  });

  it('counts every bucket worst-first and shows only the buckets that exist', () => {
    render(
      <LiveStrip
        lanes={[
          lane({ phase: 1, status: 'running' }),
          lane({ phase: 2, status: 'running' }),
          lane({ phase: 3, status: 'gated' }),
        ]}
      />,
    );
    const counts = screen.getByTestId('live-strip').firstElementChild as HTMLElement;
    const words = counts.textContent ?? '';
    // needs-you leads (worst-first), then running with its 2; no queued chip at all.
    expect(words.indexOf('need you')).toBeLessThan(words.indexOf('running'));
    expect(words).toContain('need you1');
    expect(words).toContain('running2');
    expect(words).not.toContain('queued');
  });

  it('a frozen lane is badged frozen and its clock does not run', () => {
    render(
      <LiveStrip
        lanes={[lane({ phase: 1, status: 'running', frozen: true, startedAt: new Date().toISOString() })]}
      />,
    );
    expect(screen.getByTestId('strip-lane').textContent).toContain('frozen');
  });
});
