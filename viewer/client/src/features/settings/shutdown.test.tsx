/**
 * What the Restart and Shut-down dialogs claim, and whether it is true.
 *
 * The original defect was silence: a restart killed every pty and no dialog
 * said so. Phase 6 made it say so. Phase 7 made the saying WRONG — the ptys
 * moved to a broker that outlives the console — and a dialog that went on
 * promising to stop them would be the same defect with the sign flipped.
 *
 * So the split is asserted from both sides: a session that survives is never
 * in the stop list, a session that does not is never in the keep list, and the
 * flag is read rather than assumed in either direction.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SessionInventory } from '@/lib/api';
import { StopInventory, keepList, stopList } from './shutdown';

const inventory = (over: Partial<SessionInventory> = {}): SessionInventory => ({
  live: 3,
  agent: 2,
  terminal: 1,
  ended: 0,
  sessions: [],
  ...over,
});

const RUN = { slug: 'demo', status: 'running' };

describe('what a restart or a shutdown claims', () => {
  it('lists sessions as stopped only while they really do stop', () => {
    const stops = stopList(inventory({ survives: false }), null);
    expect(stops).toEqual(['2 agent sessions', '1 terminal']);
    expect(keepList(inventory({ survives: false }))).toEqual([]);
  });

  it('moves them to the keep list once the broker owns them', () => {
    const sessions = inventory({ survives: true });
    expect(stopList(sessions, null)).toEqual([]);
    expect(keepList(sessions)).toEqual(['2 agent sessions', '1 terminal']);
  });

  it('still stops the run, whichever side the sessions fall on', () => {
    expect(stopList(inventory({ survives: true }), RUN)[0]).toMatch(/demo run \(running\)/);
    expect(stopList(inventory({ survives: false }), RUN)[0]).toMatch(/demo run \(running\)/);
  });

  it('assumes nothing when the server predates the flag', () => {
    // An older server sends no `survives`. The safe reading is the OLD
    // behaviour — say they stop — because claiming a session is safe when it
    // is about to die is the worse of the two errors.
    expect(stopList(inventory(), null)).toEqual(['2 agent sessions', '1 terminal']);
    expect(keepList(inventory())).toEqual([]);
  });

  it('renders both halves, and says why the kept ones are kept', () => {
    render(
      <StopInventory
        items={stopList(inventory({ survives: true }), RUN)}
        keeps={keepList(inventory({ survives: true }))}
      />,
    );
    expect(screen.getByText('This stops:')).toBeInTheDocument();
    expect(screen.getByText('This keeps running:')).toBeInTheDocument();
    expect(screen.getByText(/held by a separate process/)).toBeInTheDocument();
  });

  it('does not say "nothing is running" while something is', () => {
    // The empty state is about the WHOLE inventory. Showing it beside a keep
    // list would be a dialog contradicting itself in two lines.
    render(<StopInventory items={[]} keeps={keepList(inventory({ survives: true }))} />);
    expect(screen.queryByText(/Nothing is running/)).toBeNull();
    expect(screen.getByText('This keeps running:')).toBeInTheDocument();
  });

  it('still says so when there genuinely is nothing', () => {
    render(<StopInventory items={[]} keeps={[]} />);
    expect(screen.getByText(/Nothing is running/)).toBeInTheDocument();
  });
});
