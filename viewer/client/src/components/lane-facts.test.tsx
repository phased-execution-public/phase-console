/**
 * The lane-fact primitive: the hedges, and the order.
 *
 * Each of these is a rule that FOUR surfaces had to get right separately
 * before phase 18 extracted them, and at least one of them got each one wrong
 * at some point — the `~~45 min` double hedge, a heartbeat that kept beating
 * over a frozen lane, a cost that printed `$NaN` for a lane with none.
 */

import { existsSync, readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LaneBeat, LaneFactRow, laneFacts, type LaneFacts } from './lane-facts';
import type { NowLane } from '@/features/runs/lanes-model';

const facts = (over: Partial<LaneFacts> = {}): LaneFacts => ({
  startedAt: Date.now() - 90_000,
  silence: null,
  costUsd: 1.5,
  model: 'opus',
  effort: null,
  etaLabel: null,
  frozen: false,
  ...over,
});

describe('laneFacts — the NowLane adapter', () => {
  it('turns unparseable clocks into absent, never into NaN', () => {
    // A `startedAt` that is an empty string parses to NaN, and `NaN` flowed
    // straight into an elapsed figure on more than one surface. Absent is a
    // fact the atoms know how to draw; NaN is not.
    const lane = {
      startedAt: '',
      liveness: { lastOutputAt: 'not a date' },
      costUsd: 0,
      slug: 'demo',
    } as unknown as NowLane;
    const out = laneFacts(lane);
    expect(out.startedAt).toBeNull();
    // A last output is not a silence: with no reading from the server the bag
    // carries none, rather than a gap timed here off that stamp (#28).
    expect(out.silence).toBeNull();
    // Zero is a REAL cost, and distinct from absent: a lane that has spent
    // nothing is different from one nobody has measured.
    expect(out.costUsd).toBe(0);
  });

  it('carries the ETA label as the server wrote it', () => {
    const lane = { eta: { label: '~45 min' }, costUsd: 0 } as unknown as NowLane;
    expect(laneFacts(lane).etaLabel).toBe('~45 min');
  });
});

describe('LaneFactRow', () => {
  it('never prefixes a second hedge onto the ETA', () => {
    // `PhaseEta.label` arrives as `~45 min`. A row that prefixed its own `~`
    // printed `~~45 min`, which reads as a typo rather than as an estimate.
    render(<LaneFactRow facts={facts({ etaLabel: '~45 min' })} live />);
    expect(screen.getByText('~45 min')).toBeInTheDocument();
    expect(screen.queryByText('~~45 min')).toBeNull();
  });

  it('draws a cost of zero and omits one it does not have', () => {
    const { unmount } = render(<LaneFactRow facts={facts({ costUsd: 0 })} live />);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    unmount();

    render(<LaneFactRow facts={facts({ costUsd: null })} live />);
    expect(screen.queryByText(/^\$/)).toBeNull();
  });

  it('says frozen only when it is, and joins effort onto the model', () => {
    const { unmount } = render(<LaneFactRow facts={facts()} live />);
    expect(screen.getByText('opus')).toBeInTheDocument();
    expect(screen.queryByText('frozen')).toBeNull();
    unmount();

    render(<LaneFactRow facts={facts({ frozen: true, effort: 'high' })} live={false} />);
    expect(screen.getByText('frozen')).toBeInTheDocument();
    expect(screen.getByText('opus · high')).toBeInTheDocument();
  });

  it('keeps the facts in the one order', () => {
    // The order IS the vocabulary — beat · elapsed · cost · ETA · model ·
    // frozen. Four surfaces each chose their own, so the same lane read
    // differently depending on which page you were on.
    const { container } = render(
      <LaneFactRow facts={facts({ etaLabel: '~45 min', frozen: true })} live={false} />,
    );
    const text = (container.firstElementChild as HTMLElement).textContent ?? '';
    expect(text.indexOf('$1.50')).toBeLessThan(text.indexOf('~45 min'));
    expect(text.indexOf('~45 min')).toBeLessThan(text.indexOf('opus'));
    expect(text.indexOf('opus')).toBeLessThan(text.indexOf('frozen'));
  });
});

describe('LaneBeat — a named silence, never one timed off the last output (control-tower phase 24, #28)', () => {
  it('prints which silence the server read, how long, and the threshold it is measured against', () => {
    const sinceMs = Date.now() - 12 * 60_000;
    render(
      <LaneBeat
        facts={facts({ silence: { kind: 'unproductive', sinceMs, thresholdMs: 30 * 60_000 } })}
        live
      />,
    );
    const beat = screen.getByTestId('lane-silence');
    expect(beat.getAttribute('data-silence')).toBe('unproductive');
    expect(beat.textContent).toMatch(/^no productive output 12m/);
    expect(beat.textContent).toMatch(/stalls at 30m/);
  });

  it('draws nothing when the server reports no silence, and nothing for a lane that is not live', () => {
    const { container, rerender } = render(<LaneBeat facts={facts()} live />);
    expect(container.textContent).toBe('');
    rerender(
      <LaneBeat
        facts={facts({ silence: { kind: 'no-output', sinceMs: Date.now(), thresholdMs: 1 } })}
        live={false}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('source scan: no silence figure on these surfaces is timed off lastOutputAt', () => {
    // The three files #28 named. Two were retired with Now (phase 21); the one
    // that remains reads the server's `liveness.silence` and nothing else.
    const here = (path: string) => new URL(path, import.meta.url);
    expect(existsSync(here('../features/now/model.ts'))).toBe(false);
    expect(existsSync(here('../features/now/lane-row.tsx'))).toBe(false);
    const source = readFileSync(here('./lane-facts.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source).not.toMatch(/lastOutputAt/);
    expect(source).not.toMatch(/<Heartbeat\b/);
  });
});
