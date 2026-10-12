/**
 * One lane's Freeze, Continue and Stop (7.0, quiet-console phase 11; the cases
 * of `features/runs/lane-controls.test.tsx`).
 *
 * Three properties: a destructive Stop never fires without its question, and
 * the question promises the one thing that tells this verb from the run's own
 * Stop — the rest of the run carries on; a queued lane offers only the
 * dequeue-stop (there is no process to freeze); and without `--allow-run` the
 * controls are disabled with the reason in reach, never hidden. Each press goes
 * through the lane's own door — the run's route with the phase named.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, post: (path: string, body?: unknown) => post(path, body) };
});

import type { RunState } from '@/data/api';
import { RunLaneControls, laneFrozen } from './lane-controls';

function mount(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ run: null });
});

describe('RunLaneControls', () => {
  it('stops one lane only after its question, which promises the run carries on', async () => {
    mount(<RunLaneControls slug="demo" phase={9} live allowRun frozen={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText(/the other lanes keep working/i)).toBeInTheDocument();
    expect(within(question).getByText(/interrupted rather than failed/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    fireEvent.click(within(question).getByRole('button', { name: 'Stop this phase' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/stop', { phase: 9 }));
  });

  it('offers Freeze for a live lane and Continue for a frozen one, each through the lane’s own door', async () => {
    const { unmount } = mount(<RunLaneControls slug="demo" phase={9} live allowRun frozen={null} />);
    expect(screen.getByRole('group', { name: 'Phase 9 session controls' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/freeze', { phase: 9 }));
    unmount();

    mount(
      <RunLaneControls
        slug="demo"
        phase={9}
        live
        allowRun
        frozen={{ at: '2026-08-06T10:00:00Z', by: 'me', escalateAt: '2026-08-06T10:15:00Z' }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/thaw', { phase: 9 }));
  });

  it('a queued lane gets the dequeue-stop and nothing to freeze', async () => {
    mount(<RunLaneControls slug="demo" phase={7} live allowRun frozen={null} queued />);
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText(/out of the admission line/i)).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: 'Leave it queued' })).toBeInTheDocument();
  });

  it('without --allow-run the controls are disabled with the reason, never hidden', () => {
    mount(<RunLaneControls slug="demo" phase={9} live allowRun={false} frozen={null} />);
    const freeze = screen.getByRole('button', { name: 'Freeze' });
    expect(freeze).toBeDisabled();
    expect(freeze.getAttribute('title')).toMatch(/--allow-run/);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('draws nothing for a lane that holds no session', () => {
    const { container } = mount(
      <RunLaneControls slug="demo" phase={9} live={false} allowRun frozen={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('laneFrozen', () => {
  const base = { id: 'r1', slug: 'demo' } as unknown as RunState;
  const ref = { at: 'a', by: 'b', escalateAt: 'c' };

  it('prefers the per-lane record, falls back to the single slot, and never cross-reads', () => {
    expect(
      laneFrozen(
        {
          ...base,
          children: { 9: { pid: 1, phase: 9, sessionId: '', startedAt: '', frozen: ref } },
        } as RunState,
        9,
      ),
    ).toEqual(ref);

    expect(
      laneFrozen(
        {
          ...base,
          freeze: { at: 'a', phase: 9, pid: 1, by: 'b', escalateAt: 'c' },
        } as RunState,
        9,
      ),
    ).toEqual(ref);

    expect(
      laneFrozen(
        {
          ...base,
          freeze: { at: 'a', phase: 7, pid: 1, by: 'b', escalateAt: 'c' },
        } as RunState,
        9,
      ),
    ).toBeNull();
    expect(laneFrozen(null, 9)).toBeNull();
  });
});
