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

import type { SessionInventory, ShutdownInventory, StopPlanView } from '@/lib/api';
import { StopInventory, durabilitySentence, inventoryItems, keepList, stopList } from './shutdown';

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

/**
 * ACC-6.1 / ACC-6.4 (SHD-1, SHD-5). The dialog said "Nothing is running — no
 * session, no run" over a lane 36.8 minutes from its resume, and "The launchd
 * job is unloaded, so it stays off" over a bootout the next login undid. The
 * list is now the server's inventory, and each strength's sentence is what that
 * strength achieves.
 */
describe('the Shut down dialog is the inventory, and each strength says what it achieves', () => {
  const empty = (): ShutdownInventory => ({
    lanes: [],
    clocks: [],
    runs: [],
    liveSessions: [],
    pendingApprovals: [],
    inboxDepth: { sessions: 0, outcomes: 0 },
  });

  it('names every lane, the soonest WORK clock, the runs on disk, the live sessions, the cards and the unread inboxes', () => {
    const inventory: ShutdownInventory = {
      ...empty(),
      lanes: [{ slug: 'demo', runId: 'r1', phase: 3, pid: 4242, sessionId: 's1' }],
      clocks: [
        { source: 'session-inbox', at: '2026-09-15T10:00:00.100Z' },
        { source: 'wait-resume', at: '2026-09-15T10:36:48.000Z', slug: 'hub-plan' },
      ],
      runs: [
        {
          slug: 'hub-plan',
          id: 'r2',
          status: 'paused',
          waitUntil: '2026-09-15T10:36:48.000Z',
          live: false,
          clock: null,
        },
      ],
      liveSessions: [
        { sessionId: '9d8b45ec-aaaa', kind: 'foreign', pid: 66601, cwd: '/work/hub', plan: null },
      ],
      pendingApprovals: [
        { id: 'a1', slug: 'demo', phase: 3, kind: 'tool', expiresAt: '2026-09-15T11:00:00.000Z' },
      ],
      inboxDepth: { sessions: 3, outcomes: 1 },
    };
    const items = inventoryItems(inventory);
    expect(items[0]).toMatch(/^demo phase 3 \(pid 4242\)/);
    expect(items[1]).toMatch(/^the wait-resume clock for hub-plan due/);
    expect(items[1]).toMatch(/and 1 more clock/);
    expect(items.some((item) => /the hub-plan run \(paused, until/.test(item))).toBe(true);
    expect(
      items.some((item) => /1 live Claude session this console is watching \(9d8b45ec\)/.test(item)),
    ).toBe(true);
    expect(items.some((item) => /1 pending approval/.test(item))).toBe(true);
    expect(items.some((item) => /3 presence events and 1 declaration not yet read/.test(item))).toBe(true);
    expect(inventoryItems(empty())).toEqual([]);
  });

  it('says "nothing" only when the measured inventory is empty, and says what confirming acknowledges otherwise', () => {
    const { unmount } = render(<StopInventory items={[]} keeps={[]} acknowledging />);
    expect(screen.getByText(/Nothing is running, armed, waiting or unread/)).toBeInTheDocument();
    unmount();
    render(<StopInventory items={['demo phase 3 (pid 4242)']} acknowledging />);
    expect(screen.getByText(/confirming stops all of it/)).toBeInTheDocument();
  });

  it("makes each strength's promise the one it keeps", () => {
    const plan = (over: Partial<StopPlanView>): StopPlanView => ({
      via: 'exit',
      mode: 'exit',
      durability: 'stays-off',
      detail: '',
      ...over,
    });
    expect(durabilitySentence(plan({ durability: 'returns' }))).toMatch(/starts it again within seconds/);
    expect(durabilitySentence(plan({ durability: 'until-login' }))).toMatch(
      /next login starts the unit again/,
    );
    expect(durabilitySentence(plan({ durability: 'stays-off' }), 'bash start')).toBe(
      'Nothing brings it back. To start it again: bash start',
    );
    const off = durabilitySentence(
      plan({
        via: 'launchctl',
        mode: 'unload',
        durability: 'disabled',
        resurrect: 'launchctl enable gui/$(id -u)/com.example',
      }),
    );
    expect(off).toMatch(/unloaded and disabled and a stop marker holds its automation/);
    expect(off).toMatch(/a login does not bring it back/);
    expect(off).toMatch(/To start it again: launchctl enable/);
  });
});
