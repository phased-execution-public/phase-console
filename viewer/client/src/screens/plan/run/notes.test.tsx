/**
 * What people decided about this run (7.0, quiet-console phase 12; the cases
 * carried from the 6.x notes card's suite, control-tower phase 96, #142).
 *
 * Pinned: a pinned note is a standing decision, so it leads and stays until
 * somebody unpins it; the composer writes exactly what the route reads —
 * `{text, pinned}` — and sends once; the newest few loose notes are drawn and
 * the rest fold, one press away; and a console that can neither read a note
 * nor write one says nothing at all.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { post, toastSpy } = vi.hoisted(() => ({ post: vi.fn(), toastSpy: vi.fn() }));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, post: (path: string, body?: unknown) => post(path, body) };
});
vi.mock('@/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui')>();
  return { ...actual, toast: (...args: unknown[]) => toastSpy(...args) };
});

import type { RunNote, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { RunOperatorNotes, notesInOrder } from './notes';

const note = (over: Partial<RunNote> & { id: string }): RunNote => ({
  at: '2026-09-26T07:10:00.000Z',
  by: 'mobin',
  text: 'a remark',
  pinned: false,
  ...over,
});

function mount(notes: RunNote[], opts: { allowRun?: boolean; everything?: boolean } = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const run = { id: 'r1', slug: 'demo', notes } as unknown as RunState;
  const view = render(
    <QueryClientProvider client={client}>
      <RunOperatorNotes run={run} allowRun={opts.allowRun ?? true} everything={opts.everything ?? false} />
    </QueryClientProvider>,
  );
  return { ...view, invalidate };
}

afterEach(() => {
  post.mockReset();
  toastSpy.mockReset();
});

describe('<RunOperatorNotes>', () => {
  it('NT-2: shows pinned notes first, with a way to unpin them', () => {
    mount([
      note({ id: 'a', text: 'an aside' }),
      note({ id: 'b', text: 'keep this run on admin@ past its weekly limit', pinned: true }),
    ]);
    const pinned = screen.getByRole('list', { name: 'Pinned notes' });
    expect(within(pinned).getByText('keep this run on admin@ past its weekly limit')).toBeTruthy();
    expect(within(pinned).getByText('Pinned')).toBeInTheDocument();
    expect(within(pinned).getByRole('button', { name: /Unpin/ })).toBeTruthy();
    const recent = screen.getByRole('list', { name: 'Recent notes' });
    expect(within(recent).getByText('an aside')).toBeTruthy();
    expect(within(recent).getByRole('button', { name: /^Pin/ })).toBeTruthy();
    // The pinned group leads the fold.
    expect(pinned.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says who wrote a note, when, and the phase it is about', () => {
    mount([note({ id: 'a', text: 'held P4 back a day', by: 'operator', phase: 4 })]);
    const row = screen.getByText('held P4 back a day').closest('li')!;
    expect(within(row).getByText('operator')).toBeInTheDocument();
    expect(row.querySelector('time')).not.toBeNull();
    expect(within(row).getByText('about phase 4')).toBeInTheDocument();
  });

  it('unpins with {id, pinned: false}, and re-reads the run', async () => {
    post.mockResolvedValue({ note: note({ id: 'b' }), run: { id: 'r1', slug: 'demo' } });
    const { invalidate } = mount([note({ id: 'b', text: 'a standing decision', pinned: true })]);
    fireEvent.click(screen.getByRole('button', { name: /Unpin/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/run/demo/notes', { id: 'b', pinned: false }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Unpinned', 'ok'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.run('demo') });
  });

  it('NT-1: writes {text, pinned} to the run, then clears the composer', async () => {
    post.mockResolvedValue({ note: note({ id: 'c', text: 'x' }), run: { id: 'r1', slug: 'demo' } });
    const { invalidate } = mount([]);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '  bumped P66 ahead of P67  ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pin it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add the note' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/run/demo/notes', {
        text: 'bumped P66 ahead of P67',
        pinned: true,
      }),
    );
    await waitFor(() => expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe(''));
    expect(screen.getByRole('checkbox', { name: 'Pin it' })).toHaveAttribute('aria-checked', 'false');
    expect(toastSpy).toHaveBeenCalledWith('Note added and pinned', 'ok');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.run('demo') });
  });

  it('sends once for a double press, and never an empty note', async () => {
    let answer!: (value: unknown) => void;
    post.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    mount([]);
    const add = screen.getByRole('button', { name: 'Add the note' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'one decision' } });
    fireEvent.submit(add.closest('form')!);
    fireEvent.submit(add.closest('form')!);
    expect(post).toHaveBeenCalledTimes(1);
    answer({ note: note({ id: 'd' }), run: { id: 'r1', slug: 'demo' } });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Note added', 'ok'));
  });

  it('keeps the words when the write is refused, and says the server’s own', async () => {
    post.mockRejectedValue(new Error('run not found'));
    mount([]);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the note' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('run not found', 'error'));
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('keep me');
  });

  it('a read-only console reads the notes, moves none, and says what writing needs', () => {
    mount([note({ id: 'a', text: 'a standing decision', pinned: true })], { allowRun: false });
    expect(screen.getByText('a standing decision')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unpin|^Pin/ })).toBeNull();
    expect(screen.queryByTestId('note-composer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeDisabled();
    expect(screen.getByTestId('notes-read-only').textContent).toBe('Needs --allow-run on this console.');
  });

  it('says one line when the run has no note yet, and offers the composer', () => {
    mount([]);
    expect(screen.getByText('No note on this run yet.')).toBeInTheDocument();
    expect(screen.getByTestId('note-composer')).toBeInTheDocument();
  });

  it('says nothing to a console that can neither read a note nor write one', () => {
    const { container } = mount([], { allowRun: false });
    expect(container.textContent).toBe('');
  });

  it('folds the older notes behind one press, and draws them under Everything', () => {
    const many = Array.from({ length: 8 }, (_, i) => note({ id: `n${i}`, text: `note ${i}` }));
    const { unmount } = mount(many);
    expect(screen.queryByText('note 0')).toBeNull();
    fireEvent.click(screen.getByTestId('notes-older'));
    const older = screen.getByRole('list', { name: 'Older notes' });
    expect(
      within(older)
        .getAllByTestId('run-note')
        .map((row) => row.querySelector('p')!.textContent),
    ).toEqual(['note 2', 'note 1', 'note 0']);
    unmount();
    mount(many, { everything: true });
    expect(screen.queryByTestId('notes-older')).toBeNull();
    expect(screen.getByRole('list', { name: 'Older notes' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = mount([
      note({ id: 'a', text: 'an aside' }),
      note({ id: 'b', text: 'a standing decision', pinned: true }),
    ]);
    await expectNoAxeViolations(container);
  });
});

describe('notesInOrder', () => {
  it('keeps the newest few unpinned notes, newest first, and the rest after them', () => {
    const many = Array.from({ length: 8 }, (_, i) => note({ id: `n${i}`, text: `note ${i}` }));
    const { recent, earlier } = notesInOrder(many);
    expect(recent.map((one) => one.text)).toEqual(['note 7', 'note 6', 'note 5', 'note 4', 'note 3']);
    expect(earlier.map((one) => one.text)).toEqual(['note 2', 'note 1', 'note 0']);
  });

  it('leads with the pinned notes, oldest first — a standing decision’s age is part of it', () => {
    const { pinned } = notesInOrder([
      note({ id: 'a', text: 'first decision', pinned: true }),
      note({ id: 'b', text: 'an aside' }),
      note({ id: 'c', text: 'second decision', pinned: true }),
    ]);
    expect(pinned.map((one) => one.text)).toEqual(['first decision', 'second decision']);
  });
});
