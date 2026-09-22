/**
 * "Notes for this phase" — the operator's window onto a channel that is
 * otherwise invisible until a session boards.
 *
 * Three properties:
 *
 * 1. **It shows what the boot prompt will carry, in that order**, from the
 *    engine's own arm — never a second reading of the same three files.
 * 2. **A phase nobody wrote to renders nothing at all.** A section that says
 *    "no notes" on every phase of every plan is a section people learn to
 *    skip, and then they miss the phase that has one.
 * 3. **Each note says which kind it is**, because the three are different
 *    promises: a handoff bullet, a session's own deferral, and mail that can
 *    be acknowledged by id.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import type { PhaseNote } from '@/lib/api';
import { NotesSection } from './notes-section';

const { notes } = vi.hoisted(() => ({ notes: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, notes } };
});

const NOTES: PhaseNote[] = [
  {
    source: 'phase-1',
    kind: 'message',
    id: '111111111111',
    at: '2026-01-07T10:00:00Z',
    text: 'the branch was re-cut',
  },
  {
    source: 'phase-01-root',
    kind: 'handoff',
    id: '-',
    at: '2026-01-02',
    text: 'the merge reads both halves',
  },
  {
    source: 'phase-2',
    kind: 'deferral',
    id: 'aaaaaaaaaaaa',
    at: '2026-01-06T10:00:00Z',
    text: 'left the second decoder',
  },
];

function draw(rows: PhaseNote[], enabled = true) {
  notes.mockResolvedValue({ slug: 'demo', phase: 4, notes: rows });
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <NotesSection slug="demo" phase={4} enabled={enabled} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('NotesSection', () => {
  beforeEach(() => {
    notes.mockReset();
  });

  it('lists what the boot prompt will carry, in the engine’s order', async () => {
    const { container } = draw(NOTES);
    await screen.findByText('the branch was re-cut');
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    // The engine already decided the order — urgent mail first, then oldest to
    // newest. A page that re-sorted would be telling the operator a different
    // story from the one the session is told.
    expect(items[0]).toContain('the branch was re-cut');
    expect(items[1]).toContain('the merge reads both halves');
    expect(items[2]).toContain('left the second decoder');
    // Each kind is named, and mail carries the id you acknowledge it by.
    expect(items[0]).toContain('mail');
    expect(items[0]).toContain('111111111111');
    expect(items[1]).toContain('handoff');
    expect(items[2]).toContain('deferral');
    // A handoff bullet has no id, and `-` is a placeholder, not a fact.
    expect(items[1]).not.toContain('-·');
    await expectNoAxeViolations(container);
  });

  it('renders nothing for a phase nobody wrote to', async () => {
    draw([]);
    await waitFor(() => expect(notes).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Notes for this phase' })).toBeNull();
    expect(screen.queryByText(/Notes for this phase/)).toBeNull();
  });

  it('counts only real notes, never the bound’s trailer', async () => {
    draw([
      ...NOTES,
      { source: '-', kind: 'trailer', id: '-', at: '-', text: '… and 9 older notes, not shown' },
    ]);
    const heading = await screen.findByRole('heading', { name: /Notes for this phase/ });
    expect(heading.textContent).toContain('(3)');
    // The trailer is still shown — it is how a reader learns the list is cut.
    expect(screen.getByText('… and 9 older notes, not shown')).toBeTruthy();
  });

  it('asks for nothing while the sheet around it is closed', async () => {
    draw(NOTES, false);
    await waitFor(() => expect(notes).not.toHaveBeenCalled());
  });
});
