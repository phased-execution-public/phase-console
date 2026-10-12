/**
 * Talking to a live lane (7.0, quiet-console phase 12) — every case of the 6.x
 * ask box's suite.
 *
 * The defect these exist for survived in plain sight: the box always SHOWED
 * which phase it spoke to and never TOLD the server, which falls back to the
 * lowest-numbered live lane — so with two lanes up, a correction typed under
 * the higher phase reached the lower one's session. The rest are what an
 * operator's fingers depend on: a double press sends once, a settled lane
 * offers nothing to press, and a refusal is said in the server's words.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/data/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/http')>()),
  post: (path: string, body?: unknown) => post(path, body),
}));

import { Toaster } from '@/ui';
import { AskBox } from './ask';

beforeEach(() => {
  post.mockReset().mockResolvedValue({ ok: true });
});

const box = (over: Partial<Parameters<typeof AskBox>[0]> = {}) =>
  render(
    <>
      <AskBox slug="demo" enabled allowRun phase={21} {...over} />
      <Toaster />
    </>,
  );

const field = () => screen.getByLabelText(/A question for the session|What to do differently/);
const sent = (verb: 'ask' | 'steer') => post.mock.calls.filter(([path]) => path === `/api/run/demo/${verb}`);

describe('AskBox', () => {
  it('sends an Ask to the NAMED lane, not to whichever lane is lowest', async () => {
    box();
    fireEvent.change(field(), { target: { value: 'why the rebuild?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(sent('ask')).toHaveLength(1));
    const [, body] = sent('ask')[0]!;
    expect(body).toEqual({ question: 'why the rebuild?', key: expect.any(String), phase: 21 });
  });

  it('sends a Steer to the named lane too, through the steer verb', async () => {
    box();
    fireEvent.change(screen.getByLabelText('What this message is'), { target: { value: 'steer' } });
    fireEvent.change(field(), { target: { value: 'use the existing helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));

    await waitFor(() => expect(sent('steer')).toHaveLength(1));
    expect(sent('ask')).toHaveLength(0);
    expect(sent('steer')[0]![1]).toEqual({
      instruction: 'use the existing helper',
      key: expect.any(String),
      phase: 21,
    });
  });

  it('addresses the run, not a lane, when no phase is named', async () => {
    box({ phase: null });
    fireEvent.change(field(), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(sent('ask')).toHaveLength(1));
    // The key is absent, never `null`: that is how the protocol says "not stated".
    expect(sent('ask')[0]![1]).not.toHaveProperty('phase');
  });

  it('strips the /btw and /steer people actually type', async () => {
    box();
    fireEvent.change(field(), { target: { value: '/btw are you stuck?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(sent('ask')).toHaveLength(1));
    expect((sent('ask')[0]![1] as { question: string }).question).toBe('are you stuck?');
  });

  it('sends once when Enter and the button land in the same tick', async () => {
    box();
    fireEvent.change(field(), { target: { value: 'anyone there?' } });
    // The in-flight REF is what lets the second caller see the first.
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Ask|Sending/ }));
    await waitFor(() => expect(sent('ask')).toHaveLength(1));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('clears the field once sent, and says so when the server saw a duplicate', async () => {
    post.mockResolvedValue({ ok: true, repeated: true });
    box();
    fireEvent.change(field(), { target: { value: 'again?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('Already sent: this one was a duplicate')).toBeInTheDocument();
    expect(field()).toHaveValue('');
  });

  it('keeps the words and says the server’s refusal as it was said', async () => {
    post.mockRejectedValue(new Error('No session is listening on phase 21.'));
    box();
    fireEvent.change(field(), { target: { value: 'hello?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('No session is listening on phase 21.')).toBeInTheDocument();
    expect(field()).toHaveValue('hello?');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('offers nothing to press when the lane has settled, and says why', () => {
    box({ enabled: false });
    expect(field()).toBeDisabled();
    expect(screen.getByLabelText('What this message is')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    expect(screen.getByPlaceholderText('Nothing is running to ask')).toBeInTheDocument();
    expect(screen.getByText('Available while a phase is running')).toBeInTheDocument();
  });

  it('names the missing flag when the console cannot run anything at all', () => {
    box({ enabled: false, allowRun: false });
    expect(screen.getByPlaceholderText('Asking needs --allow-run')).toBeInTheDocument();
  });

  it('never sends an empty message', async () => {
    box();
    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it('says what each act does before it is sent', () => {
    box();
    expect(screen.getByText('Answered in the same session, then it carries on')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What this message is'), { target: { value: 'steer' } });
    expect(screen.getByText(/Folded into the work/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Tell the session running phase 21 to do something differently'),
    ).toBeInTheDocument();
  });
});
