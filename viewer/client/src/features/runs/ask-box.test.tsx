/**
 * Talking to a live lane — the client half.
 *
 * The component had no tests, which is how the defect below survived in plain
 * sight: the box has always *shown* which phase it is speaking to and never
 * *told* the server. The server addresses a named lane and falls back to the
 * lowest-numbered live one, so with two lanes up, a course correction typed
 * under the higher phase was delivered to the lower phase's session — and the
 * placeholder in the same box named the phase it was not reaching.
 *
 * The other properties are the ones an operator's fingers depend on: a
 * double-fire sends once, and a settled lane offers nothing to press.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AskBox } from './ask-box';

const { runAsk, runSteer } = vi.hoisted(() => ({
  runAsk: vi.fn(),
  runSteer: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runAsk, runSteer } };
});

beforeEach(() => {
  runAsk.mockReset().mockResolvedValue({ ok: true, mark: 'ask:aaaa1111' });
  runSteer.mockReset().mockResolvedValue({ ok: true, mark: 'steer:bbbb2222' });
});

const box = (over: Partial<Parameters<typeof AskBox>[0]> = {}) =>
  render(<AskBox slug="demo" enabled allowRun phase={21} {...over} />);

const field = () => screen.getByLabelText(/A question for the session|What to do differently/);

describe('AskBox', () => {
  it('sends an Ask to the NAMED lane, not to whichever lane is lowest', async () => {
    box();

    fireEvent.change(field(), { target: { value: 'why the rebuild?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(runAsk).toHaveBeenCalledTimes(1));
    const [slug, body, key, phase] = runAsk.mock.calls[0];
    expect(slug).toBe('demo');
    expect(body).toBe('why the rebuild?');
    expect(key).toEqual(expect.any(String));
    // The whole point: the phase reaches the server, so `laneFor` addresses
    // phase 21 rather than falling back to `mirrorLane()`.
    expect(phase).toBe(21);
  });

  it('sends a Steer to the named lane too, through the steer verb', async () => {
    box();

    fireEvent.change(screen.getByLabelText('What this message is'), { target: { value: 'steer' } });
    fireEvent.change(field(), { target: { value: 'use the existing helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));

    await waitFor(() => expect(runSteer).toHaveBeenCalledTimes(1));
    expect(runAsk).not.toHaveBeenCalled();
    const [slug, body, , phase] = runSteer.mock.calls[0];
    expect(slug).toBe('demo');
    expect(body).toBe('use the existing helper');
    expect(phase).toBe(21);
  });

  it('addresses the run level, not a lane, when no phase is named', async () => {
    box({ phase: null });

    fireEvent.change(field(), { target: { value: 'status?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(runAsk).toHaveBeenCalledTimes(1));
    // `undefined`, never `null`: the api helper omits the key entirely, which
    // is how the protocol says "not stated" everywhere else in this console.
    expect(runAsk.mock.calls[0][3]).toBeUndefined();
  });

  it('strips the /btw and /steer prefixes people actually type', async () => {
    box();

    fireEvent.change(field(), { target: { value: '/btw are you stuck?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await waitFor(() => expect(runAsk).toHaveBeenCalledTimes(1));
    expect(runAsk.mock.calls[0][1]).toBe('are you stuck?');
  });

  it('sends once when Enter and the button land in the same tick', async () => {
    box();

    fireEvent.change(field(), { target: { value: 'anyone there?' } });
    // The in-flight REF is what makes the second caller see the first —
    // `sending` state would still read false for both inside one tick.
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Ask|Sending/ }));

    await waitFor(() => expect(runAsk).toHaveBeenCalledTimes(1));
    expect(runAsk).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to press when the lane has settled', () => {
    box({ enabled: false });

    expect(field()).toBeDisabled();
    expect(screen.getByLabelText('What this message is')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    // And says why, rather than looking broken.
    expect(screen.getByPlaceholderText('Nothing is running to ask')).toBeInTheDocument();
  });

  it('names the missing flag when the console cannot run anything at all', () => {
    box({ enabled: false, allowRun: false });
    expect(screen.getByPlaceholderText('Asking needs --allow-run')).toBeInTheDocument();
  });

  it('never sends an empty message', async () => {
    box();

    fireEvent.change(field(), { target: { value: '   ' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    await waitFor(() => expect(runAsk).not.toHaveBeenCalled());
  });
});
