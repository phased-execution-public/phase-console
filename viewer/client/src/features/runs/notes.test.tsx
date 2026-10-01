/**
 * The run page's notes (control-tower phase 96, #142): a pinned note is a
 * standing decision, so it is shown first and stays until somebody unpins it,
 * and the box writes exactly what the route reads — `{text, pinned}`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { RunNote, RunState } from '@/lib/api';
import { NotesCard, notesForCard } from './notes';

const { runNote, runPinNote } = vi.hoisted(() => ({ runNote: vi.fn(), runPinNote: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runNote, runPinNote } };
});

const note = (over: Partial<RunNote> & { id: string }): RunNote => ({
  at: '2026-09-26T07:10:00.000Z',
  by: 'mobin',
  text: 'a remark',
  pinned: false,
  ...over,
});

function mount(notes: RunNote[], allowRun = true) {
  const run = { id: 'r1', slug: 'demo', notes } as unknown as RunState;
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <MemoryRouterProvider>
        <NotesCard run={run} allowRun={allowRun} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

describe('NotesCard', () => {
  it('NT-2: shows pinned notes first, with a way to unpin them', () => {
    mount([
      note({ id: 'a', text: 'an aside' }),
      note({ id: 'b', text: 'keep this run on admin@ past its weekly limit', pinned: true }),
    ]);
    const pinned = screen.getByRole('list', { name: 'Pinned notes' });
    expect(within(pinned).getByText('keep this run on admin@ past its weekly limit')).toBeTruthy();
    expect(within(pinned).getByRole('button', { name: /Unpin/ })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Recent notes' })).getByText('an aside')).toBeTruthy();
  });

  it('NT-1: writes {text, pinned} to the run', async () => {
    runNote.mockResolvedValue({ note: note({ id: 'c', text: 'x' }), run: { id: 'r1', slug: 'demo' } });
    mount([]);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  bumped P66 ahead of P67  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pin it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin note' }));
    await waitFor(() =>
      expect(runNote).toHaveBeenCalledWith('demo', { text: 'bumped P66 ahead of P67', pinned: true }),
    );
  });

  it('says nothing to a console that can neither read a note nor write one', () => {
    const { container } = mount([], false);
    expect(container.textContent).toBe('');
  });

  it('keeps the newest few unpinned notes, and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => note({ id: `n${i}`, text: `note ${i}` }));
    const { recent, older } = notesForCard(many);
    expect(recent.map((one) => one.text)).toEqual(['note 7', 'note 6', 'note 5', 'note 4', 'note 3']);
    expect(older).toBe(3);
  });
});
